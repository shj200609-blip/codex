import { codexRoot } from "./paths.mjs";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { AppServerClient } from "../src/appServer/client";
import { WebSocketTransport } from "../src/appServer/transport";
import type { ChangeSet } from "../src/appServer/protocol";
import type { ChangeSetRef, ReviewNode } from "../src/changes/models";

const root = process.env.CODEX_LIFECYCLE_ROOT!;
const binary =
  process.env.CODEX_APP_SERVER_BIN ??
  resolve(codexRoot(resolve(__dirname, "..")), "codex-rs/target/debug/codex-app-server");
type Stage = {
  phase: number;
  hostPid: number;
  revisions: number[];
  previousChild?: number;
  node?: ReviewNode;
};
async function lenses(uri: vscode.Uri) {
  await vscode.workspace.openTextDocument(uri);
  return (
    (await vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      uri,
      1000,
    )) ?? []
  ).filter(
    (lens) =>
      lens.command?.command.startsWith("codexChanges.") ||
      /^(✓ (Accepted|Reviewed)|↶ Reverted|\? Unsupported|⚠ (Conflict|Location conflict|Save or discard))/.test(
        lens.command?.title ?? "",
      ),
  );
}
async function report(name: string) {
  const path = join(root, "host-results.json");
  const results = await readFile(path, "utf8")
    .then(JSON.parse)
    .catch(() => []);
  results.push({ name, status: "PASS" });
  await writeFile(path, JSON.stringify(results, null, 2));
  console.log(`LIFECYCLE PASS: ${name}`);
}
async function restart(stage: Stage): Promise<never> {
  await writeFile(join(root, "stage.json"), JSON.stringify(stage));
  assert.ok(
    (await vscode.commands.getCommands()).includes(
      "workbench.action.restartExtensionHost",
    ),
  );
  // The ordinary development Host reactivates our isolated driver after the
  // built-in restart. No extension-test callback blocks VS Code initialization.
  void vscode.commands.executeCommand("workbench.action.restartExtensionHost");
  return new Promise<never>(() => {});
}
async function ownedPid(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const rows = execFileSync("/bin/ps", ["-axo", "pid,ppid,command"], {
      encoding: "utf8",
    }).split("\n");
    for (const row of rows) {
      const match = row.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      if (
        match &&
        Number(match[2]) === process.pid &&
        match[3].startsWith(binary)
      )
        return Number(match[1]);
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Owned standalone stdio child not found");
}
export async function run() {
  try {
    assert.ok(root && vscode.workspace.isTrusted);
    const state = JSON.parse(
      await readFile(join(root, "state.json"), "utf8"),
    ) as {
      url: string;
      workspace: string;
      references: ChangeSetRef[];
    };
    assert.equal(state.references.length, 2);
    const extension = vscode.extensions.getExtension(
      "codex-local.codex-changes-review",
    );
    assert.ok(extension);
    await extension.activate();
    const stage = (await readFile(join(root, "stage.json"), "utf8")
      .then(JSON.parse)
      .catch(() => ({ phase: 0 }))) as Stage;
    if (stage.phase <= 1) {
      const client = new AppServerClient(
        new WebSocketTransport(state.url),
        console.log,
      );
      await client.start();
      try {
        let sets: ChangeSet[] = await Promise.all(
          state.references.map(async (ref) => {
            const { changeSet } = await client.request("changeSet/read", ref);
            assert.ok(changeSet);
            return changeSet;
          }),
        );
        const file = sets[0].files.find((file) =>
          file.path.endsWith("/src/a.rs"),
        )!;
        const node: ReviewNode = {
          kind: "hunk",
          ref: {
            ...state.references[0],
            fileId: file.id,
            hunkId: file.hunks[0].id,
          },
        };
        if (stage.phase === 0) {
          await client.request("changeSet/hunk/accept", node.ref);
          await new Promise((done) => setTimeout(done, 150));
          sets = await Promise.all(
            state.references.map(
              async (ref) =>
                (await client.request("changeSet/read", ref)).changeSet!,
            ),
          );
          const observed = await lenses(vscode.Uri.parse(file.path));
          assert.ok(
            observed.some((lens) => lens.command?.title.includes("Accepted")),
          );
          await report(
            "External producer/reviewer decision reaches shared host before true reload",
          );
          await client.stop();
          return await restart({
            phase: 1,
            hostPid: process.pid,
            revisions: sets.map((set) => set.revision),
            node,
          });
        }
        assert.notEqual(process.pid, stage.hostPid);
        assert.deepEqual(
          sets.map((set) => set.revision),
          stage.revisions,
        );
        const before = await lenses(vscode.Uri.parse(file.path));
        assert.ok(
          before.some((lens) => lens.command?.title.includes("Accepted")),
        );
        const secondFile = sets[1].files[0];
        assert.ok(
          (await lenses(vscode.Uri.parse(secondFile.path))).some(
            (lens) =>
              lens.command?.arguments?.[0].ref.changeSetId === sets[1].id,
          ),
        );
        await report(
          "True shared Extension Host restart preserves both retained sets, revision and decisions",
        );
        await client.stop();
        const config = vscode.workspace.getConfiguration("codexChanges");
        await config.update(
          "serverCommand",
          binary,
          vscode.ConfigurationTarget.Workspace,
        );
        await config.update(
          "serverArgs",
          ["--disable-plugin-startup-tasks-for-tests"],
          vscode.ConfigurationTarget.Workspace,
        );
        await config.update(
          "connectionMode",
          "stdio",
          vscode.ConfigurationTarget.Workspace,
        );
        await new Promise((done) => setTimeout(done, 900));
        await vscode.commands.executeCommand("codexChanges.restart");
        const pid = await ownedPid();
        assert.equal((await lenses(vscode.Uri.parse(file.path))).length, 0);
        await vscode.commands.executeCommand(
          "workbench.action.closeAllEditors",
        );
        await report(
          "Owned real stdio child starts and clears foreign shared-session lenses",
        );
        return await restart({
          phase: 2,
          hostPid: process.pid,
          previousChild: pid,
          revisions: stage.revisions,
          node,
        });
      } finally {
        await client.stop();
      }
    }
    assert.equal(stage.phase, 2);
    assert.notEqual(process.pid, stage.hostPid);
    const pid = await ownedPid();
    assert.notEqual(pid, stage.previousChild);
    let oldAlive = true;
    try {
      process.kill(stage.previousChild!, 0);
    } catch {
      oldAlive = false;
    }
    assert.equal(
      oldAlive,
      false,
      "Old owned child must have exited after true Host reload",
    );
    await vscode.commands.executeCommand("codexChanges.openFile", stage.node);
    assert.ok(
      !vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .some((tab) => tab.input instanceof vscode.TabInputTextDiff),
    );
    await report(
      "True owned stdio Extension Host restart replaces child and rejects stale shared review target",
    );
    const shared = new AppServerClient(
      new WebSocketTransport(state.url),
      console.log,
    );
    await shared.start();
    try {
      const revisions = await Promise.all(
        state.references.map(
          async (ref) =>
            (await shared.request("changeSet/read", ref)).changeSet!.revision,
        ),
      );
      assert.deepEqual(revisions, stage.revisions);
      await report(
        "Owned child reload does not stop or mutate the separate shared server",
      );
    } finally {
      await shared.stop();
    }
    await writeFile(
      join(root, "host-success.txt"),
      "All lifecycle assertions passed.\n",
    );
    setTimeout(() => {
      void vscode.commands.executeCommand("workbench.action.closeWindow");
    }, 500);
  } catch (error) {
    await writeFile(
      join(root, "host-error.txt"),
      String(error) + "\n" + (error as Error).stack,
    );
    throw error;
  }
}
