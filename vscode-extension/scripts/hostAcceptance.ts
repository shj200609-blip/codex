import { codexRoot } from "./paths.mjs";
// Real forked server + local mock model. No OpenAI account or model calls.
import assert from "node:assert/strict";
import * as vscode from "vscode";
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
import { ChangeTreeProvider } from "../src/changes/changeTreeProvider";
import { reference, type ChangeSetRef } from "../src/changes/models";
import type { ChangeSet, HunkLocationResult } from "../src/appServer/protocol";
import type { ThreadStartParams } from "@codex/app-server-protocol/v2/ThreadStartParams";
import type { ThreadStartResponse } from "@codex/app-server-protocol/v2/ThreadStartResponse";
import type { TurnStartParams } from "@codex/app-server-protocol/v2/TurnStartParams";

function nextChangeSet(client: AppServerClient): Promise<ChangeSet> {
  return new Promise((done, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("ChangeSet creation timeout"));
    }, 30000);
    const off = client.onNotification("changeSet/created", ({ changeSet }) => {
      clearTimeout(timer);
      off();
      done(changeSet);
    });
  });
}
function completedTurn(
  client: AppServerClient,
  threadId: string,
): Promise<void> {
  return new Promise((done, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("Turn completion timeout"));
    }, 30000);
    const off = client.onNotification(
      "turn/completed",
      ({ threadId: id, turn }) => {
        if (id !== threadId) return;
        clearTimeout(timer);
        off();
        if (turn.status !== "completed")
          reject(
            new Error(`Turn ${turn.status}: ${JSON.stringify(turn.error)}`),
          );
        else done();
      },
    );
  });
}
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
  const dir = root;
  const home = join(dir, "home"),
    workspace = join(dir, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(join(workspace, "src"), { recursive: true });
  await rm(join(workspace, "added.txt"), { force: true });
  await rm(join(workspace, "empty.txt"), { force: true });
  const original =
    Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
  await writeFile(join(workspace, "src/a.rs"), original);
  await writeFile(join(workspace, "src/b.rs"), original);
  await writeFile(join(workspace, "deleted.txt"), "deleted baseline\n");
  await writeFile(join(dir, "initial-content.txt"), original);
  await writeFile(
    join(workspace, "c.txt"),
    Array.from({ length: 60 }, (_, i) => `line-${i + 1}`).join("\n") + "\n",
  );
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/a.rs",
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
    "*** Update File: src/b.rs",
    "@@",
    " line-4",
    "-line-5",
    " line-6",
    "@@",
    " line-27",
    "-line-28",
    "+second-b",
    " line-29",
    "*** Update File: c.txt",
    "@@",
    " line-4",
    "-line-5",
    "+first-c",
    " line-6",
    "@@",
    " line-27",
    "-line-28",
    "+second-c",
    " line-29",
    "@@",
    " line-49",
    "-line-50",
    "+third-c",
    " line-51",
    "*** End Patch",
    "",
  ].join("\n");
  const patch2 = [
    "*** Begin Patch",
    "*** Add File: added.txt",
    "+added content",
    "*** Add File: empty.txt",
    "*** Delete File: deleted.txt",
    "*** Update File: bof.txt",
    "@@",
    "-drop-bof",
    " keep-bof",
    "*** Update File: middle.txt",
    "@@",
    " keep-before",
    "-drop-middle",
    " keep-after",
    "*** Update File: eof.txt",
    "@@",
    " keep-eof",
    "-drop-eof",
    "*** Update File: emptied.txt",
    "@@",
    "-drop-empty",
    "*** Update File: oversized.txt",
    "@@",
    "-large-target",
    "+large-changed",
    "*** End Patch",
    "",
  ].join("\n");
  await writeFile(join(workspace, "bof.txt"), "drop-bof\nkeep-bof\n");
  await writeFile(
    join(workspace, "middle.txt"),
    "keep-before\ndrop-middle\nkeep-after\n",
  );
  await writeFile(join(workspace, "eof.txt"), "keep-eof\ndrop-eof\n");
  await writeFile(join(workspace, "emptied.txt"), "drop-empty\n");
  await writeFile(
    join(workspace, "oversized.txt"),
    "large-target\n" + "x".repeat(4 * 1024 * 1024) + "\n",
  );
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
        index % 2 === 0
          ? {
              type: "response.output_item.done",
              item: {
                type: "function_call",
                call_id: "patch",
                name: "exec_command",
                arguments: JSON.stringify(
                  index === 4
                    ? {
                        cmd: "printf producer-owns-approval",
                        sandbox_permissions: "require_escalated",
                        justification:
                          "Local acceptance fixture approval ownership check",
                      }
                    : {
                        cmd: `apply_patch <<'EOF'\n${index === 0 ? patch : patch2}EOF\n`,
                      },
                ),
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
  let producerTransport: WebSocketTransport | undefined;
  let peer: AppServerClient | undefined;
  let store: ChangeSetStore | undefined;
  let peerStore: ChangeSetStore | undefined;
  let saved: ChangeSetRef | undefined;
  try {
    if (port) {
      await processHost.start();
      // Allow listener startup, retrying only connection establishment before any RPC.
      for (let attempt = 0; attempt < 50; attempt++) {
        const transport = new WebSocketTransport(`ws://127.0.0.1:${port}`);
        const candidate = new AppServerClient(transport, log);
        try {
          await candidate.start();
          client = candidate;
          producerTransport = transport;
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
    assert.ok(
      vscode.workspace.isTrusted,
      "Temporary test workspace must be trusted",
    );
    const extension = vscode.extensions.getExtension(
      "codex-local.codex-changes-review",
    );
    assert.ok(
      extension,
      "Development extension is installed in real Extension Host",
    );
    await extension.activate();
    const config = vscode.workspace.getConfiguration("codexChanges");
    await config.update(
      "connectionMode",
      "websocket",
      vscode.ConfigurationTarget.Workspace,
    );
    await config.update(
      "websocketUrl",
      `ws://127.0.0.1:${port}`,
      vscode.ConfigurationTarget.Workspace,
    );
    await new Promise((done) => setTimeout(done, 750));
    await vscode.commands.executeCommand("codexChanges.restart");
    check("Real Extension Host activation and shared WebSocket connection");
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
    const completedA = completedTurn(client, thread.id);
    await producer.request("turn/start", turnParams);
    const set = await setCreated;
    await completedA;
    const nextSet = nextChangeSet(client);
    const completedB = completedTurn(client, thread.id);
    await producer.request("turn/start", turnParams);
    const secondSet = await nextSet;
    await completedB;
    assert.notEqual(set.id, secondSet.id);
    assert.notEqual(set.turnId, secondSet.turnId);
    check("Two real consecutive turns create distinct retained ChangeSets");
    let approvals = 0,
      commandExecuted = false;
    const approve = (raw: string) => {
      const message = JSON.parse(raw);
      if (
        message.id === undefined ||
        message.method !== "item/commandExecution/requestApproval"
      )
        return;
      approvals++;
      // The observer has time to receive the broadcast first. Only this test
      // producer owns the reply; any observer rejection would prevent execution.
      setTimeout(
        () =>
          producerTransport!.send(
            JSON.stringify({ id: message.id, result: { decision: "accept" } }),
          ),
        250,
      );
    };
    assert.ok(producerTransport);
    producerTransport.on("message", approve);
    const offExecution = client.onNotification("item/completed", ({ item }) => {
      if (
        item.type === "commandExecution" &&
        item.exitCode === 0 &&
        item.aggregatedOutput?.includes("producer-owns-approval")
      )
        commandExecuted = true;
    });
    const approvalTurn = completedTurn(client, thread.id);
    await producer.request("turn/start", {
      ...turnParams,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
    await approvalTurn;
    producerTransport.off("message", approve);
    offExecution();
    assert.equal(approvals, 1, "Real server must request producer approval");
    assert.ok(
      commandExecuted,
      "Only producer approval may allow the requested tool to execute",
    );
    check(
      "Real broadcast tool approval remains producer-owned while review Extension Host is connected",
    );
    assert.equal(set.coverage, "applyPatchOnly");
    assert.equal(set.storage, "sessionMemory");
    const ref = reference(set);
    const file = (name: string) => {
      const found = [set, secondSet]
        .flatMap((value) => value.files)
        .find((value) => value.path.endsWith("/" + name));
      assert.ok(found, name);
      return found;
    };
    const refFor = (name: string) =>
      reference(
        [set, secondSet].find((value) =>
          value.files.some((f) => f.id === file(name).id),
        )!,
      );
    const nativeNode = (name: string, index?: number) => ({
      kind: index === undefined ? "file" : "hunk",
      ref: {
        ...refFor(name),
        fileId: file(name).id,
        ...(index === undefined ? {} : { hunkId: file(name).hunks[index].id }),
      },
    });
    const open = async (
      name: string,
      index?: number,
      expectedLine?: number,
    ) => {
      await vscode.commands.executeCommand(
        index === undefined ? "codexChanges.openFile" : "codexChanges.openHunk",
        nativeNode(name, index),
      );
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(
        tab?.input instanceof vscode.TabInputTextDiff,
        `Native diff tab must open for ${name}`,
      );
      const input = tab.input;
      assert.ok(input instanceof vscode.TabInputTextDiff);
      assert.equal(input.original.scheme, "codex-change");
      assert.equal(
        (await vscode.workspace.openTextDocument(tab.input.original)).getText(),
        file(name).beforeContent ?? "",
      );
      if (expectedLine !== undefined) {
        const editor = vscode.window.visibleTextEditors.find(
          (e) => e.document.uri.toString() === input.modified.toString(),
        );
        assert.ok(editor, "Current-side editor must be visible");
        assert.equal(
          editor.selection.start.line,
          expectedLine - 1,
          "Real editor selection must use live Core coordinates",
        );
        assert.ok(
          editor.visibleRanges.some((range) =>
            range.contains(editor.selection.start),
          ),
          "Current live selection must be visible after revealRange",
        );
      }
      return tab.input;
    };
    await vscode.commands.executeCommand("codexChanges.refresh");
    const tree = new ChangeTreeProvider(store!);
    const walk = (parent?: import("../src/changes/models").ReviewNode) => {
      for (const node of tree.getChildren(parent)) {
        assert.ok(node.kind !== "hunk" || parent?.kind === "file");
        assert.deepEqual(tree.getParent(node), parent);
        const item = tree.getTreeItem(node);
        assert.ok(item instanceof vscode.TreeItem);
        assert.ok(!String(item.label).includes("Turn"));
        assert.ok(!String(item.description).includes("Pending"));
        if (node.kind === "hunk" && item.label !== "Empty file")
          assert.ok(
            item.description,
            "Real patch must have a changed-line preview",
          );
        walk(node);
      }
    };
    walk();
    // Native API constructs real TreeItems; normal extension's view is visually
    // checked separately. Do not count provider assertions as mouse checks.
    tree.dispose();
    check(
      "Real native TreeItems hide protocol IDs, show patch previews and preserve parent hierarchy",
    );
    const aDiff = await open("src/a.rs", 1, 29);
    check(
      "Native baseline/current diff, second hunk selection and visible range",
    );
    assert.equal(
      vscode.workspace.getConfiguration("diffEditor").get("codeLens"),
      true,
    );
    const initialLenses = await codeLenses(aDiff.modified);
    assert.ok(
      initialLenses.every(
        (lens) => !/Codex ·|Turn |Pending/.test(lens.command?.title ?? ""),
      ),
    );
    assert.ok(
      initialLenses.some((lens) => lens.command?.title === "✓ Accept Change"),
    );
    assert.ok(
      initialLenses.some((lens) => lens.command?.title === "↶ Revert Change"),
    );
    check(
      "Native CodeLens presents compact Accept Change / Revert Change without protocol metadata",
    );
    const firstLens = initialLenses.find(
      (lens) =>
        lens.command?.command === "codexChanges.revertHunk" &&
        lens.command.arguments?.[0].ref.hunkId === file("src/a.rs").hunks[0].id,
    )!;
    const secondLens = initialLenses.find(
      (lens) =>
        lens.command?.command === "codexChanges.acceptHunk" &&
        lens.command.arguments?.[0].ref.hunkId === file("src/a.rs").hunks[1].id,
    )!;
    assert.ok(firstLens && secondLens);
    assert.equal(secondLens.range.start.line, 28);
    assert.deepEqual(
      secondLens.command!.arguments![0],
      nativeNode("src/a.rs", 1),
    );
    const baselineLenses =
      (await vscode.commands.executeCommand<vscode.CodeLens[]>(
        "vscode.executeCodeLensProvider",
        aDiff.original,
        1000,
      )) ?? [];
    assert.ok(
      !baselineLenses.some((lens) =>
        lens.command?.command.startsWith("codexChanges."),
      ),
    );
    check(
      "Real CodeLens provider binds full stable IDs to Core positions and suppresses historical-side actions",
    );
    const dirtyEditor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === aDiff.modified.toString(),
    );
    assert.ok(dirtyEditor);
    const diskBeforeDirty = await readFile(join(workspace, "src/a.rs"), "utf8");
    const revisionBeforeDirty = (await client.request("changeSet/read", ref))
      .changeSet!.revision;
    await dirtyEditor.edit((edit) =>
      edit.insert(new vscode.Position(0, 0), "unsaved-only\n"),
    );
    assert.ok(dirtyEditor.document.isDirty);
    const dirtyLenses = await codeLenses(aDiff.modified);
    assert.ok(
      dirtyLenses.some((lens) =>
        lens.command?.title.includes("Save or discard"),
      ),
    );
    assert.ok(
      !dirtyLenses.some((lens) =>
        /accept|revert/i.test(lens.command?.command ?? ""),
      ),
    );
    check("Dirty buffers remove all hunk/file CodeLens review actions");
    const blockedAccept = vscode.commands.executeCommand(
      "codexChanges.acceptHunk",
      nativeNode("src/a.rs", 1),
    );
    const blockedRevert = vscode.commands.executeCommand(
      "codexChanges.revertHunk",
      nativeNode("src/a.rs", 0),
    );
    await new Promise((done) => setTimeout(done, 250));
    assert.equal(
      (await client.request("changeSet/read", ref)).changeSet!.revision,
      revisionBeforeDirty,
    );
    assert.equal(
      await readFile(join(workspace, "src/a.rs"), "utf8"),
      diskBeforeDirty,
    );
    const commands = await vscode.commands.getCommands();
    assert.ok(
      commands.includes("notifications.clearAll"),
      "Notification dismiss command must exist",
    );
    await vscode.commands.executeCommand("notifications.clearAll");
    await Promise.all([blockedAccept, blockedRevert]);
    check(
      "Real unsaved buffer blocks both Accept and Revert without disk/state mutation",
    );
    dirtyEditor.selection = new vscode.Selection(0, 0, 0, 0);
    const dirtyOpen = vscode.commands.executeCommand(
      "codexChanges.openHunk",
      nativeNode("src/a.rs", 1),
    );
    await new Promise((done) => setTimeout(done, 250));
    await vscode.commands.executeCommand("notifications.clearAll");
    await dirtyOpen;
    assert.equal(
      dirtyEditor.selection.start.line,
      0,
      "Unsaved diff must not force disk-derived selection",
    );
    check("Unsaved native diff omits disk-derived reveal selection");
    await dirtyEditor.edit((edit) => edit.delete(new vscode.Range(0, 0, 1, 0)));
    await dirtyEditor.document.save();
    assert.equal(
      await readFile(join(workspace, "src/a.rs"), "utf8"),
      diskBeforeDirty,
    );
    assert.equal(file("c.txt").hunks.length, 3);
    await vscode.commands.executeCommand(
      "codexChanges.acceptHunk",
      nativeNode("c.txt", 0),
    );
    await vscode.commands.executeCommand(
      "codexChanges.revertHunk",
      nativeNode("c.txt", 1),
    );
    const mixed = (
      await client.request("changeSet/read", ref)
    ).changeSet!.files.find((f) => f.id === file("c.txt").id)!;
    assert.deepEqual(
      mixed.hunks.map((h) => h.state),
      ["accepted", "reverted", "pending"],
    );
    const revisionMixed = (await client.request("changeSet/read", ref))
      .changeSet!.revision;
    await vscode.commands.executeCommand(
      "codexChanges.revertHunk",
      nativeNode("c.txt", 0),
    );
    await vscode.commands.executeCommand(
      "codexChanges.acceptHunk",
      nativeNode("c.txt", 1),
    );
    assert.equal(
      (await client.request("changeSet/read", ref)).changeSet!.revision,
      revisionMixed,
    );
    check(
      "Three-hunk mixed decisions preserve Accepted/Reverted/Pending and terminal action guards",
    );
    const bDiff = await open("src/b.rs", 0, 5);
    const bEditor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === bDiff.modified.toString(),
    );
    assert.ok(
      bEditor?.selection.isEmpty,
      "Pure deletion reveals zero-length cursor",
    );
    check("Native pure-deletion cursor anchor");
    const addedDiff = await open("added.txt");
    assert.equal(addedDiff.modified.scheme, "file");
    const emptyDiff = await open("empty.txt", 0);
    assert.equal(
      (await vscode.workspace.openTextDocument(emptyDiff.modified)).getText(),
      "",
    );
    check("Added file empty baseline and empty-file presence diff");
    const deletedDiff = await open("deleted.txt");
    assert.equal(deletedDiff.modified.scheme, "codex-change");
    assert.equal(
      (await vscode.workspace.openTextDocument(deletedDiff.modified)).getText(),
      "",
    );
    assert.match(
      vscode.window.tabGroups.activeTabGroup.activeTab!.label,
      /file absent/,
    );
    check("Deleted-file virtual current side and absence title");
    const emptyLenses = await codeLenses(emptyDiff.modified);
    assert.ok(
      emptyLenses.some(
        (lens) =>
          lens.command?.command === "codexChanges.revertHunk" &&
          lens.range.start.line === 0,
      ),
    );
    const absentLenses = await codeLenses(deletedDiff.modified);
    assert.ok(
      absentLenses.some(
        (lens) =>
          lens.command?.command === "codexChanges.revertHunk" &&
          lens.range.start.line === 0,
      ),
    );
    check(
      "Empty added and absent deleted files expose explicitly scoped file-presence CodeLens",
    );
    for (const name of ["bof.txt", "middle.txt", "eof.txt", "emptied.txt"]) {
      const input = await open(name, 0);
      const editor = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.toString() === input.modified.toString(),
      );
      assert.ok(editor?.selection.isEmpty);
      assert.ok(
        editor.selection.start.line >= 0 &&
          editor.selection.start.line < editor.document.lineCount,
      );
      const locator: HunkLocationResult = (
        await client.request(
          "changeSet/hunk/locate",
          nativeNode(name, 0).ref as never,
        )
      ).result;
      assert.ok(
        locator.status === "located" && locator.kind === "deletionAnchor",
      );
      const lenses = await codeLenses(input.modified);
      assert.equal(
        lenses.find(
          (lens) => lens.command?.command === "codexChanges.revertHunk",
        )!.range.start.line,
        Math.min(editor.document.lineCount - 1, locator.startLine - 1),
      );
    }
    check(
      "Real Core BOF/middle/EOF/empty-document deletion anchors are valid in native editor and CodeLens",
    );
    assert.equal(file("oversized.txt").state, "unsupported");
    assert.match(file("oversized.txt").unsupportedReason!, /4 MiB/);
    const unsupportedDocument = await vscode.workspace.openTextDocument(
      vscode.Uri.file(join(workspace, "oversized.txt")),
    );
    const unsupportedLenses = await codeLenses(unsupportedDocument.uri);
    assert.ok(
      unsupportedLenses.some((lens) =>
        lens.command?.title.includes("Unsupported"),
      ),
    );
    assert.ok(
      !unsupportedLenses.some((lens) =>
        /accept|revert/i.test(lens.command?.command ?? ""),
      ),
    );
    check(
      "Real Core oversized unsupported file has read-only native CodeLens and no review actions",
    );
    const a = file("src/a.rs"),
      b = file("src/b.rs");
    assert.equal(a.hunks.length, 2);
    assert.equal(b.hunks.length, 2);
    const hunkRef = (name: string, index = 0) => ({
      ...refFor(name),
      fileId: file(name).id,
      hunkId: file(name).hunks[index].id,
    });
    const revisionBeforeLocate = (await client.request("changeSet/read", ref))
      .changeSet!.revision;
    assert.equal(
      (await client.request("changeSet/hunk/locate", hunkRef("src/b.rs")))
        .result.status,
      "located",
    );
    const deletion = (
      await client.request("changeSet/hunk/locate", hunkRef("src/b.rs"))
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
      revisionBeforeLocate,
      "locate must be read-only",
    );
    await clickLens(firstLens);
    assert.equal(
      (await client.request("changeSet/read", ref)).changeSet!.files.find(
        (f) => f.id === a.id,
      )!.hunks[0].state,
      "reverted",
    );
    await settleDisk("src/a.rs");
    await open("src/a.rs", 1, 28);
    check("Actual Revert Hunk command shifts remaining native diff selection");
    const afterRevert = await codeLenses(aDiff.modified);
    assert.ok(
      !afterRevert.some(
        (lens) =>
          lens.command?.command === "codexChanges.revertHunk" &&
          lens.command.arguments?.[0].ref.hunkId ===
            file("src/a.rs").hunks[0].id,
      ),
    );
    assert.equal(
      afterRevert.find(
        (lens) => lens.command?.command === "codexChanges.acceptHunk",
      )!.range.start.line,
      27,
    );
    check(
      "Clicking an actual Revert CodeLens removes its terminal actions and relocates the next lens",
    );
    const selectionBeforeReverted = vscode.window.activeTextEditor!.selection;
    const reopened = vscode.commands.executeCommand(
      "codexChanges.openHunk",
      nativeNode("src/a.rs", 0),
    );
    await new Promise((done) => setTimeout(done, 250));
    await vscode.commands.executeCommand("notifications.clearAll");
    await reopened;
    assert.ok(
      vscode.window.activeTextEditor!.selection.isEqual(
        selectionBeforeReverted,
      ),
    );
    check("Reverted hunk navigation leaves current native selection unchanged");
    const shifted = (
      await client.request("changeSet/hunk/locate", hunkRef("src/a.rs", 1))
    ).result;
    assert.ok(shifted.status === "located");
    assert.equal(shifted.startLine, 28);
    const inserted =
      Array.from({ length: 20 }, (_, i) => `user-${i}`).join("\n") + "\n";
    await writeFile(
      join(workspace, "src/a.rs"),
      inserted + (await readFile(join(workspace, "src/a.rs"), "utf8")),
    );
    const relocated = (
      await client.request("changeSet/hunk/locate", hunkRef("src/a.rs", 1))
    ).result;
    assert.ok(relocated.status === "located");
    assert.equal(relocated.startLine, 48);
    await settleDisk("src/a.rs");
    const movedDiff = await open("src/a.rs", 1, 48);
    assert.equal(
      movedDiff.original.toString(),
      aDiff.original.toString(),
      "All hunks reuse one baseline URI",
    );
    check(
      "Saved 20-line insertion moves native selection and keeps baseline URI",
    );
    const movedLenses = await codeLenses(aDiff.modified);
    const staleAccept = movedLenses.find(
      (lens) => lens.command?.command === "codexChanges.acceptHunk",
    )!;
    const staleRevert = movedLenses.find(
      (lens) => lens.command?.command === "codexChanges.revertHunk",
    )!;
    assert.equal(staleAccept.range.start.line, 47);
    const observerTransport = new WebSocketTransport(`ws://127.0.0.1:${port}`);
    const reviewerA = new AppServerClient(observerTransport, log);
    await reviewerA.start();
    try {
      await reviewerA.request("changeSet/hunk/accept", hunkRef("src/a.rs", 1));
    } finally {
      await reviewerA.stop();
    }
    await new Promise((done) => setTimeout(done, 100));
    const acceptedRevision = (await client.request("changeSet/read", ref))
      .changeSet!.revision;
    await clickLens(staleAccept);
    await clickLens(staleRevert);
    assert.equal(
      (await client.request("changeSet/read", ref)).changeSet!.revision,
      acceptedRevision,
    );
    const remoteLenses = await codeLenses(aDiff.modified);
    assert.ok(
      remoteLenses.some((lens) => lens.command?.title.includes("Accepted")),
    );
    assert.ok(
      !remoteLenses.some((lens) =>
        /acceptHunk|revertHunk/.test(lens.command?.command ?? ""),
      ),
    );
    check(
      "Another client Accept updates observer CodeLens; both old inline actions cannot change server revision",
    );
    assert.equal(
      (await client.request("changeSet/read", ref)).changeSet!.files.find(
        (f) => f.id === a.id,
      )!.hunks[1].state,
      "accepted",
    );
    await open("src/a.rs", 1, 48);
    check("Actual Accept Hunk command and accepted-hunk native navigation");
    await vscode.commands.executeCommand("codexChanges.restart");
    await open("src/a.rs", 1, 48);
    check(
      "Shared-server Reconnect restores retained review decisions and diff navigation",
    );
    assert.equal(
      (await client.request("changeSet/hunk/locate", hunkRef("src/a.rs", 1)))
        .result.status,
      "located",
    );
    await writeFile(
      join(workspace, "src/b.rs"),
      (await readFile(join(workspace, "src/b.rs"), "utf8")).replace(
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
        peerStore.get(ref)!.revision,
        store.get(ref)!.revision,
        "late review client restores existing session",
      );
    }
    await settleDisk("src/b.rs");
    await vscode.commands.executeCommand("codexChanges.revertAll", {
      kind: "changeSet",
      ref,
    });
    const partial = (
      await client.request("changeSet/read", ref)
    ).changeSet!.files.flatMap((f) => f.hunks);
    assert.equal(
      (await client.request("changeSet/read", reference(secondSet))).changeSet!
        .revision,
      secondSet.revision,
    );
    check(
      "Explicit Revert All on older set leaves second pending set untouched",
    );
    check(
      "Actual Revert All command returns partial Reverted/Conflict/Accepted states",
    );
    assert.ok(partial.some((result) => result.state === "conflict"));
    assert.ok(partial.some((result) => result.state === "reverted"));
    assert.equal(
      store.all[0].files.find((value) => value.id === a.id)?.hunks[1].state,
      "accepted",
    );
    assert.match(
      await readFile(join(workspace, "src/b.rs"), "utf8"),
      /user-edited-b/,
    );
    assert.ok(
      (await readFile(join(workspace, "src/a.rs"), "utf8")).startsWith(
        inserted,
      ),
    );
    if (peerStore) {
      await new Promise((done) => setTimeout(done, 100));
      assert.equal(
        peerStore.get(ref)!.revision,
        store.get(ref)!.revision,
        "subscribed peer receives review snapshot",
      );
    }
    console.log(
      `${mode}: real apply_patch → created → locate → partial revert/accept → conflict → snapshots OK`,
    );
    await settleDisk("src/b.rs");
    await open("src/b.rs");
    const currentTab = vscode.window.tabGroups.activeTabGroup.activeTab!
      .input as vscode.TabInputTextDiff;
    assert.match(
      (await vscode.workspace.openTextDocument(currentTab.modified)).getText(),
      /user-edited-b/,
    );
    check("Conflict preserves user edit in real native diff");
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
    assert.equal(
      peerStore!.all.length,
      2,
      "Late client/reconnect must recover both retained consecutive turns",
    );
    await vscode.commands.executeCommand(
      "codexChanges.revertFile",
      nativeNode("added.txt"),
    );
    const target = (
      await client.request("changeSet/read", reference(secondSet))
    ).changeSet!;
    assert.equal(
      target.files.find((f) => f.id === file("added.txt").id)!.hunks[0].state,
      "reverted",
    );
    assert.equal(
      target.files.find((f) => f.id === file("empty.txt").id)!.hunks[0].state,
      "pending",
    );
    await vscode.commands.executeCommand("codexChanges.acceptAll", {
      kind: "changeSet",
      ref: reference(secondSet),
    });
    assert.equal(
      (
        await client.request("changeSet/read", reference(secondSet))
      ).changeSet!.files.find((f) => f.id === file("empty.txt").id)!.hunks[0]
        .state,
      "accepted",
    );
    check(
      "File and ChangeSet bulk actions retain explicit second-turn scope and terminal decisions",
    );
    await processHost.stop();
    await peer?.stop();
    await client.stop();
    await processHost.start();
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
    assert.equal(client.connectionState, "Ready");
    assert.equal(
      (await client.request("thread/loaded/list", { limit: 100 })).data.length,
      0,
    );
    await vscode.commands.executeCommand("codexChanges.restart");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand(
      "codexChanges.openFile",
      nativeNode("src/a.rs"),
    );
    assert.ok(
      !vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .some((tab) => tab.input instanceof vscode.TabInputTextDiff),
    );
    check(
      "Real shared server stop/start plus observer reconnect clears expired ChangeSet and stale diff actions",
    );
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
  }
}
const root = resolve(vscode.workspace.workspaceFolders![0].uri.fsPath, "..");
const results: {
  name: string;
  status: "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
}[] = [];
async function codeLenses(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const lenses =
      (await vscode.commands.executeCommand<vscode.CodeLens[]>(
        "vscode.executeCodeLensProvider",
        uri,
        1000,
      )) ?? [];
    const ours = lenses.filter(
      (lens) =>
        lens.command?.command.startsWith("codexChanges.") ||
        !!lens.command?.arguments?.[0]?.ref?.changeSetId ||
        /^(✓ (Accepted|Reviewed)|↶ Reverted|\? Unsupported|⚠ (Conflict|Location conflict|Save or discard))/.test(
          lens.command?.title ?? "",
        ),
    );
    if (ours.length) return ours;
    await new Promise((done) => setTimeout(done, 100));
  }
  return [];
}
async function clickLens(lens: vscode.CodeLens) {
  const command = lens.command;
  assert.ok(command);
  assert.ok(command.command.startsWith("codexChanges."));
  await vscode.commands.executeCommand(
    command.command,
    ...(command.arguments ?? []),
  );
}
function check(name: string) {
  results.push({ name, status: "PASS" });
  console.log(`HOST PASS: ${name}`);
  require("node:fs").writeFileSync(
    join(root, "host-results.json"),
    JSON.stringify(results, null, 2),
  );
}
async function settleDisk(name: string) {
  const path = join(vscode.workspace.workspaceFolders![0].uri.fsPath, name);
  const wanted = await readFile(path, "utf8").catch(() => "");
  for (let i = 0; i < 50; i++) {
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.scheme === "file" && d.uri.fsPath === path,
    );
    if (!doc || doc.getText() === wanted) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`VS Code document failed to refresh from disk: ${name}`);
}
export async function run() {
  require("node:fs").rmSync(join(root, "host-error.txt"), { force: true });
  require("node:fs").rmSync(join(root, "host-results.json"), { force: true });
  require("node:fs").writeFileSync(
    join(root, "host-environment.json"),
    JSON.stringify(
      {
        trusted: vscode.workspace.isTrusted,
        version: vscode.version,
        workspace: vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath),
      },
      null,
      2,
    ),
  );
  try {
    await smoke("websocket");
    require("node:fs").writeFileSync(
      join(root, "host-success.txt"),
      "All Extension Host assertions passed.\n",
    );
  } catch (error) {
    require("node:fs").writeFileSync(
      join(root, "host-error.txt"),
      String(error) + "\n" + (error as Error).stack,
    );
    throw error;
  }
}
