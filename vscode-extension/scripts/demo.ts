import { codexRoot } from "./paths.mjs";
// Visible local demo: keeps a real shared App Server and mock producer alive until stopped.
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
const twoTurns = process.argv.includes("--two-turns");
async function demo(mode: "stdio" | "websocket"): Promise<void> {
  // Core rejects symlink ancestors; macOS /var and /tmp are symlinks.
  const dir = await mkdtemp(
    join(await realpath(tmpdir()), "codex-changes-smoke-"),
  );
  const home = join(dir, "home"),
    workspace =
      process.env.CODEX_DEMO_WORKSPACE ??
      join(await realpath(resolve(__dirname, "..")), "demo-workspace");
  await mkdir(home);
  await mkdir(workspace, { recursive: true });
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, ".vscode"), { recursive: true });
  // All files below are disposable demo fixtures, recreated on each run.
  await rm(join(workspace, "src/added.rs"), { force: true });
  await rm(join(workspace, "src/empty.rs"), { force: true });
  const original =
    Array.from({ length: 40 }, (_, i) => `// line-${i + 1}`).join("\n") + "\n";
  await writeFile(join(workspace, "src/a.rs"), original);
  await writeFile(join(workspace, "src/b.rs"), original);
  await writeFile(join(workspace, "src/deleted.rs"), "// deleted baseline\n");
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/a.rs",
    "@@",
    " // line-4",
    "-// line-5",
    "+// first-a",
    "+// extra-a",
    " // line-6",
    "@@",
    " // line-27",
    "-// line-28",
    "+// second-a",
    " // line-29",
    "*** Update File: src/b.rs",
    "@@",
    " // line-4",
    "-// line-5",
    " // line-6",
    "@@",
    " // line-27",
    "-// line-28",
    "+// second-b",
    " // line-29",
    "*** Add File: src/added.rs",
    "+// added content",
    "*** Add File: src/empty.rs",
    "*** Delete File: src/deleted.rs",
    "*** End Patch",
    "",
  ].join("\n");
  if (twoTurns)
    await rm(join(workspace, "src/second-turn.rs"), { force: true });
  const patch2 =
    "*** Begin Patch\n*** Add File: src/second-turn.rs\n+// ChangeSet from the second consecutive turn\n*** End Patch\n";
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
    const index = requests++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      sse([
        created,
        index === 0 || (twoTurns && index === 2)
          ? {
              type: "response.output_item.done",
              item: {
                type: "function_call",
                call_id: "patch",
                name: "exec_command",
                arguments: JSON.stringify({
                  cmd: `apply_patch <<'EOF'\n${index === 0 ? patch : patch2}EOF\n`,
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
  const log = (message: string) => console.log(message);
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
  await writeFile(
    join(workspace, ".vscode/settings.json"),
    JSON.stringify(
      {
        "codexChanges.connectionMode": "websocket",
        "codexChanges.websocketUrl": `ws://127.0.0.1:${port}`,
        "codexChanges.serverCommand": binary,
        "codexChanges.serverArgs": [],
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(workspace, "README.md"),
    [
      "# Codex Changes 演示",
      "",
      "这是一次本地演示：真实 fork App Server 已记录 apply_patch 变更，模型响应来自本地 mock，无需账号或调用真实模型。",
      "",
      "1. 如出现工作区信任提示，选择信任此演示目录。",
      "2. 点击左侧 Activity Bar 的 **Codex Changes** 图标；可将鼠标移到图标上查看名称。",
      "3. 在 **CHANGES** 中点开 `src/a.rs` 或 `src/b.rs` 的 hunk，即可看到原生 diff。",
      "4. 在修改旁的 CodeLens 直接点击 **✓ Accept / ↶ Revert**；文件顶部也有 **Accept File / Revert File**。Tree 右键操作仍可使用。",
      "",
      `初始有 ${twoTurns ? 8 : 7} 个 Pending hunk，包含两份各有两处修改的文件、新增文件、空新增文件和删除文件。Accept 记录决定，Revert 回滚演示文件。`,
      "",
      "如果 CHANGES 没有出现，可按 Cmd+Shift+P，搜索 Codex Changes 或 Open View，然后选择 CHANGES。连接正常时状态栏显示 Codex Changes: Ready。",
      "",
      "此扩展提供变更审阅界面。实际使用时，发起 Codex turn 的客户端需连接同一 App Server。",
      "",
      "重新开始演示：在 vscode-extension 目录运行 `node --import tsx scripts/demo.ts`。先停止原有演示进程；每次运行会重置这些演示文件。",
      "",
    ].join("\n"),
  );
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
    const completion = new Promise<void>((done) => {
      const off = client!.onNotification("turn/completed", () => {
        off();
        done();
      });
    });
    await producer.request("turn/start", turnParams);
    const set = await setCreated;
    await completion;
    const sets = [set];
    if (twoTurns) {
      const next = new Promise<ChangeSet>((done, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error("Second demo turn timed out"));
        }, 30000);
        const off = client!.onNotification(
          "changeSet/created",
          ({ changeSet }) => {
            clearTimeout(timer);
            off();
            done(changeSet);
          },
        );
      });
      await producer.request("turn/start", turnParams);
      sets.push(await next);
    }
    assert.equal(set.coverage, "applyPatchOnly");
    assert.equal(set.storage, "sessionMemory");
    const ref = reference(set);
    const file = (name: string) => {
      const found = set.files.find((value) => value.path.endsWith("/" + name));
      assert.ok(found, name);
      return found;
    };
    const a = file("src/a.rs"),
      b = file("src/b.rs");
    assert.equal(a.hunks.length, 2);
    assert.equal(b.hunks.length, 2);
    const demoState = {
      pid: process.pid,
      url: `ws://127.0.0.1:${port}`,
      workspace,
      pending: sets
        .flatMap((value) => value.files)
        .reduce(
          (n, f) => n + f.hunks.filter((h) => h.state === "pending").length,
          0,
        ),
      reference: ref,
      references: sets.map(reference),
    };
    const stateDir =
      process.env.CODEX_DEMO_STATE_DIR ??
      resolve(__dirname, "../acceptance-results/demo");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "state.json"),
      JSON.stringify(demoState, null, 2) + "\n",
    );
    console.log(`DEMO_READY ${JSON.stringify(demoState)}`);
    await new Promise<void>((done) => {
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
    });
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
demo("websocket").catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
