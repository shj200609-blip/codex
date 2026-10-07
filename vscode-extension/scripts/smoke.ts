import { codexRoot } from "./paths.mjs";
// Real forked server + local mock model. No OpenAI account or model calls.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { AppServerClient } from "../src/appServer/client";
import { AppServerProcess } from "../src/appServer/process";
import { StdioTransport, WebSocketTransport } from "../src/appServer/transport";
import { ChangeSetStore } from "../src/changes/changeSetStore";
import { reference, type ChangeSetRef } from "../src/changes/models";
import type { ChangeSet } from "../src/appServer/protocol";
import type { ThreadStartParams } from "@codex/app-server-protocol/v2/ThreadStartParams";
import type { ThreadStartResponse } from "@codex/app-server-protocol/v2/ThreadStartResponse";
import type { TurnStartParams } from "@codex/app-server-protocol/v2/TurnStartParams";

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}
const binary =
  process.env.CODEX_APP_SERVER_BIN ??
  resolve(codexRoot(resolve(__dirname, "..")), "codex-rs/target/debug/codex-app-server");
async function smoke(mode: "stdio" | "websocket"): Promise<void> {
  // Core rejects symlink ancestors; macOS /var and /tmp are symlinks.
  const dir = await mkdtemp(
    join(await realpath(tmpdir()), "codex-changes-smoke-"),
  );
  const home = join(dir, "home"),
    workspace = join(dir, "workspace");
  await mkdir(home);
  await mkdir(workspace);
  const original =
    Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
  await writeFile(join(workspace, "a.txt"), original);
  await writeFile(join(workspace, "b.txt"), original);
  await writeFile(join(workspace, "deleted.txt"), "deleted baseline\n");
  const patch = [
    "*** Begin Patch",
    "*** Update File: a.txt",
    "@@",
    " line-4",
    "-line-5",
    "+first-a",
    "+extra-a",
    " line-6",
    "@@",
    " line-27",
    "-line-28",
    "+second-a",
    " line-29",
    "*** Update File: b.txt",
    "@@",
    " line-4",
    "-line-5",
    " line-6",
    "@@",
    " line-27",
    "-line-28",
    "+second-b",
    " line-29",
    "*** Add File: added.txt",
    "+added content",
    "*** Add File: empty.txt",
    "*** Delete File: deleted.txt",
    "*** End Patch",
    "",
  ].join("\n");
  const sse = (items: unknown[]) =>
    items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("");
  const created = { type: "response.created", response: { id: "smoke" } };
  const completed = {
    type: "response.completed",
    response: {
      id: "smoke",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
  };
  let requests = 0;
  const model = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      sse([
        created,
        requests++ === 0
          ? {
              type: "response.output_item.done",
              item: {
                type: "function_call",
                call_id: "patch",
                name: "exec_command",
                arguments: JSON.stringify({
                  cmd: `apply_patch <<'EOF'\n${patch}EOF\n`,
                }),
              },
            }
          : {
              type: "response.output_item.done",
              item: {
                type: "message",
                role: "assistant",
                id: "message",
                content: [{ type: "output_text", text: "done" }],
              },
            },
        completed,
      ]),
    );
  });
  await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
  const modelPort = (model.address() as { port: number }).port;
  await writeFile(
    join(home, "config.toml"),
    `model = "mock-model"\nmodel_provider = "mock"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[features]\nshell_snapshot = false\n[model_providers.mock]\nname = "Local smoke mock"\nbase_url = "http://127.0.0.1:${modelPort}/v1"\nwire_api = "responses"\nsupports_websockets = false\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`,
  );
  const logs: string[] = [];
  const log = (message: string) => logs.push(message);
  const port = mode === "websocket" ? await freePort() : undefined;
  const processHost = new AppServerProcess(
    {
      command: binary,
      args: [
        "--disable-plugin-startup-tasks-for-tests",
        ...(port ? ["--listen", `ws://127.0.0.1:${port}`] : []),
      ],
      cwd: workspace,
      env: {
        ...process.env,
        CODEX_HOME: home,
        CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1",
        CODEX_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
      },
    },
    log,
  );
  let client: AppServerClient | undefined;
  let peer: AppServerClient | undefined;
  let store: ChangeSetStore | undefined;
  let peerStore: ChangeSetStore | undefined;
  let saved: ChangeSetRef | undefined;
  try {
    if (port) {
      await processHost.start();
      // Allow listener startup, retrying only connection establishment before any RPC.
      for (let attempt = 0; attempt < 50; attempt++) {
        const candidate = new AppServerClient(
          new WebSocketTransport(`ws://127.0.0.1:${port}`),
          log,
        );
        try {
          await candidate.start();
          client = candidate;
          break;
        } catch {
          await candidate.stop();
          await new Promise((done) => setTimeout(done, 100));
        }
      }
      assert.ok(client, "WebSocket server must become ready");
    } else {
      client = new AppServerClient(new StdioTransport(processHost), log);
      await client.start();
    }
    store = new ChangeSetStore(
      client,
      {
        get: () => saved,
        save: async (ref) => {
          saved = ref;
        },
      },
      (path) =>
        path === workspace ||
        path.startsWith(pathToFileURL(workspace).href + "/"),
      log,
    );
    await store.restore();
    assert.equal(store.all.length, 0);
    // Test-only producer calls; there is no conversation/turn UI in the extension.
    const producer = client as unknown as {
      request<T>(method: string, params: unknown): Promise<T>;
    };
    const params: ThreadStartParams = {
      cwd: workspace,
      model: "mock-model",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    };
    const { thread } = await producer.request<ThreadStartResponse>(
      "thread/start",
      params,
    );
    let timer: NodeJS.Timeout | undefined;
    const setCreated = new Promise<ChangeSet>((done, reject) => {
      const off = client!.onNotification(
        "changeSet/created",
        ({ changeSet }) => {
          clearTimeout(timer);
          off();
          done(changeSet);
        },
      );
      timer = setTimeout(() => {
        off();
        reject(new Error("No changeSet/created notification"));
      }, 30000);
    });
    const turnParams: TurnStartParams = {
      threadId: thread.id,
      input: [{ type: "text", text: "apply patch", text_elements: [] }],
    };
    await producer.request("turn/start", turnParams);
    const set = await setCreated;
    assert.equal(set.coverage, "applyPatchOnly");
    assert.equal(set.storage, "sessionMemory");
    const ref = reference(set);
    const file = (name: string) => {
      const found = set.files.find((value) => value.path.endsWith("/" + name));
      assert.ok(found, name);
      return found;
    };
    const a = file("a.txt"),
      b = file("b.txt");
    assert.equal(a.hunks.length, 2);
    assert.equal(b.hunks.length, 2);
    const hunkRef = (name: string, index = 0) => ({
      ...ref,
      fileId: file(name).id,
      hunkId: file(name).hunks[index].id,
    });
    assert.equal(
      (await client.request("changeSet/hunk/locate", hunkRef("b.txt"))).result
        .status,
      "located",
    );
    const deletion = (
      await client.request("changeSet/hunk/locate", hunkRef("b.txt"))
    ).result;
    assert.ok(
      deletion.status === "located" &&
        deletion.kind === "deletionAnchor" &&
        deletion.lineCount === 0,
    );
    const empty = (
      await client.request("changeSet/hunk/locate", hunkRef("empty.txt"))
    ).result;
    assert.ok(empty.status === "located" && empty.kind === "filePresence");
    assert.deepEqual(
      (await client.request("changeSet/hunk/locate", hunkRef("deleted.txt")))
        .result,
      { status: "notPresent", reason: "fileDeleted" },
    );
    assert.equal(
      (await client.request("changeSet/read", ref)).changeSet?.revision,
      set.revision,
      "locate must be read-only",
    );
    const first = await store.review("changeSet/hunk/revert", hunkRef("a.txt"));
    assert.equal(first[0].state, "reverted");
    const shifted = (
      await client.request("changeSet/hunk/locate", hunkRef("a.txt", 1))
    ).result;
    assert.ok(shifted.status === "located");
    assert.equal(shifted.startLine, 28);
    const inserted =
      Array.from({ length: 20 }, (_, i) => `user-${i}`).join("\n") + "\n";
    await writeFile(
      join(workspace, "a.txt"),
      inserted + (await readFile(join(workspace, "a.txt"), "utf8")),
    );
    const relocated = (
      await client.request("changeSet/hunk/locate", hunkRef("a.txt", 1))
    ).result;
    assert.ok(relocated.status === "located");
    assert.equal(relocated.startLine, 48);
    await store.review("changeSet/hunk/accept", hunkRef("a.txt", 1));
    assert.equal(
      (await client.request("changeSet/hunk/locate", hunkRef("a.txt", 1)))
        .result.status,
      "located",
    );
    await writeFile(
      join(workspace, "b.txt"),
      (await readFile(join(workspace, "b.txt"), "utf8")).replace(
        "second-b",
        "user-edited-b",
      ),
    );
    if (port) {
      peer = new AppServerClient(
        new WebSocketTransport(`ws://127.0.0.1:${port}`),
        log,
      );
      await peer.start();
      peerStore = new ChangeSetStore(
        peer,
        { get: () => saved, save: async () => {} },
        (path) =>
          path === workspace ||
          path.startsWith(pathToFileURL(workspace).href + "/"),
        log,
      );
      await peerStore.restore();
      assert.equal(
        peerStore.all[0].revision,
        store.all[0].revision,
        "late review client restores existing session",
      );
    }
    const partial = await store.review("changeSet/revert", ref);
    assert.ok(partial.some((result) => result.state === "conflict"));
    assert.ok(partial.some((result) => result.state === "reverted"));
    assert.equal(
      store.all[0].files.find((value) => value.id === a.id)?.hunks[1].state,
      "accepted",
    );
    assert.match(
      await readFile(join(workspace, "b.txt"), "utf8"),
      /user-edited-b/,
    );
    assert.ok(
      (await readFile(join(workspace, "a.txt"), "utf8")).startsWith(inserted),
    );
    if (peerStore) {
      await new Promise((done) => setTimeout(done, 100));
      assert.equal(
        peerStore.all[0].revision,
        store.all[0].revision,
        "subscribed peer receives review snapshot",
      );
    }
    console.log(
      `${mode}: real apply_patch → created → locate → partial revert/accept → conflict → snapshots OK`,
    );
    // Unknown session handling after a restart uses the same Core error as this invalid thread.
    await assert.rejects(
      client.request("changeSet/read", {
        threadId: "00000000-0000-0000-0000-000000000000",
        turnId: ref.turnId,
      }),
      /thread not found/,
    );
    // Exercise file endpoints as well (terminal hunks are skipped, never reopened).
    await store.review("changeSet/file/accept", { ...ref, fileId: b.id });
    await store.review("changeSet/file/revert", { ...ref, fileId: b.id });
    await store.review("changeSet/accept", ref);
  } catch (error) {
    console.error(logs.slice(-30).join("\n"));
    throw error;
  } finally {
    store?.dispose();
    peerStore?.dispose();
    await peer?.stop();
    await client?.stop();
    await processHost.stop();
    await new Promise<void>((done) => model.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
}
(async () => {
  await smoke("stdio");
  await smoke("websocket");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
