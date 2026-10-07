import assert from "node:assert/strict";
import * as vscode from "vscode";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface Connection {
  state: string;
  sharedIdeConfigured: boolean;
  endpoint: string;
  workspaceRoots: string[];
}
const root = process.env.CODEX_INSTALLED_TEST_ROOT!;
const phase = process.env.CODEX_INSTALLED_TEST_PHASE!;
async function waitFor(predicate: () => Promise<boolean>, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Installed shared IDE acceptance timed out");
}
export async function run() {
  try {
    const state = JSON.parse(
      await readFile(join(root, "test-state.json"), "utf8"),
    );
    await vscode.extensions
      .getExtension("codex-local.codex-changes-review")!
      .activate();
    const info = () =>
      vscode.commands.executeCommand<Connection>(
        "codexChanges.connectionInfo",
        { silent: true },
      );
    await waitFor(async () => (await info())?.state === "Ready");
    const ready = (await info())!;
    assert.equal(ready.sharedIdeConfigured, true);
    assert.equal(ready.endpoint, state.endpoint);
    assert.deepEqual(ready.workspaceRoots, [state.workspace]);
    assert.equal(vscode.workspace.isTrusted, true);
    if (phase === "first") {
      await writeFile(join(root, "drop-connection"), "ready");
      await waitFor(async () => (await info())?.state === "Disconnected");
      await writeFile(join(root, "disconnection-observed"), "ready");
      await waitFor(async () => (await info())?.state === "Ready");
    }
    await writeFile(
      join(root, `host-${phase}.json`),
      JSON.stringify(
        {
          ready,
          extensionHostPid: process.pid,
          automaticReconnect: phase === "first",
          trusted: vscode.workspace.isTrusted,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await writeFile(join(root, `host-${phase}-error.txt`), String(error));
    throw error;
  }
}
