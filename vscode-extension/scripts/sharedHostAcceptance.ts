import assert from "node:assert/strict";
import * as vscode from "vscode";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.env.CODEX_SHARED_ACCEPTANCE_ROOT!;
const side = process.env.CODEX_SHARED_ACCEPTANCE_SIDE!;
async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  timeout = 90000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Extension Host acceptance timed out");
}
async function lenses(path: string) {
  const uri = vscode.Uri.file(path);
  await vscode.workspace.openTextDocument(uri);
  return (
    (await vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      uri,
      1000,
    )) ?? []
  );
}
export async function run() {
  try {
    const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    const extension = vscode.extensions.getExtension(
      "codex-local.codex-changes-review",
    )!;
    assert.ok(extension);
    await extension.activate();
    await writeFile(join(root, `host-${side}-ready`), "ready");
    const path = join(
      side === "a" ? state.workspaceA : state.workspaceB,
      "src/a.rs",
    );
    const pending = await waitFor(async () => {
      const found = (await lenses(path)).filter(
        (lens) => lens.command?.command === "codexChanges.acceptHunk",
      );
      return found.length === 2 ? found : undefined;
    });
    if (side === "a") {
      await vscode.commands.executeCommand(
        "codexChanges.openHunk",
        pending[0].command!.arguments![0],
      );
      await vscode.commands.executeCommand(
        "codexChanges.acceptHunk",
        pending[0].command!.arguments![0],
      );
      const second = (await lenses(path)).find(
        (lens) => lens.command?.command === "codexChanges.revertHunk",
      )!;
      assert.ok(second);
      await vscode.commands.executeCommand(
        "codexChanges.revertHunk",
        second.command!.arguments![0],
      );
      await writeFile(
        join(root, "host-a-reviewed.json"),
        JSON.stringify(pending.map((lens) => lens.command!.arguments![0].ref)),
      );
      await waitFor(async () =>
        (await lenses(join(state.workspaceA, "src/b.rs"))).some(
          (lens) => lens.command?.command === "codexChanges.acceptHunk",
        )
          ? true
          : undefined,
      );
    }
    await waitFor(async () =>
      readFile(join(root, "check-isolation"), "utf8").catch(() => undefined),
    );
    const foreign = join(
      side === "a" ? state.workspaceB : state.workspaceA,
      "src/a.rs",
    );
    assert.equal(
      (await lenses(foreign)).filter((lens) =>
        lens.command?.command.startsWith("codexChanges."),
      ).length,
      0,
      "The actual extension must hide the other workspace's ChangeSets",
    );
    let switchedWorkspace = false;
    if (side === "a") {
      // Keep the first empty anchor stable so VS Code delivers a folder-change event
      // without restarting the Extension Host running this test.
      assert.equal(vscode.workspace.workspaceFolders?.length, 2);
      assert.ok(
        vscode.workspace.updateWorkspaceFolders(1, 1, {
          uri: vscode.Uri.file(state.workspaceB),
        }),
      );
      await waitFor(async () =>
        (await lenses(join(state.workspaceB, "src/a.rs"))).filter(
          (lens) => lens.command?.command === "codexChanges.acceptHunk",
        ).length === 2
          ? true
          : undefined,
      );
      assert.equal(
        (await lenses(join(state.workspaceA, "src/b.rs"))).filter((lens) =>
          lens.command?.command.startsWith("codexChanges."),
        ).length,
        0,
      );
      switchedWorkspace = true;
    }
    await writeFile(
      join(root, `host-${side}-success.json`),
      JSON.stringify({
        side,
        refs: pending.map((lens) => lens.command!.arguments![0].ref),
        nativeCodeLens: true,
        switchedWorkspace,
        isolated: true,
      }),
    );
  } catch (error) {
    await writeFile(
      join(root, `host-${side}-error`),
      String(error instanceof Error ? error.stack : error),
    );
    throw error;
  }
}
