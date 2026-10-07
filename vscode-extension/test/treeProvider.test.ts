import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeSetStore } from "../src/changes/changeSetStore";
import { refKey, type ReviewNode } from "../src/changes/models";
import { snapshot } from "./fixtures";
import type { RpcClient } from "../src/appServer/protocol";

const modules = require("node:module") as {
  _load: (request: string, ...args: unknown[]) => unknown;
};
const load = modules._load;
modules._load = function (request, ...args) {
  return request === "vscode"
    ? {
        EventEmitter: class {
          event = () => ({ dispose() {} });
          fire() {}
          dispose() {}
        },
        TreeItem: class {
          constructor(
            public label: string,
            public collapsibleState: number,
          ) {}
        },
        ThemeIcon: class {
          constructor(public id: string) {}
        },
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        Uri: { parse: (path: string) => path },
        workspace: {
          asRelativePath: (path: string) =>
            path.replace("file:///workspace/", ""),
        },
      }
    : load.call(this, request, ...args);
};
const { ChangeTreeProvider } =
  require("../src/changes/changeTreeProvider") as typeof import("../src/changes/changeTreeProvider");
modules._load = load;

test("Tree never flattens hunks, re-parents files for multiple sets, and preserves decision identities", () => {
  const store = new ChangeSetStore(
    { onNotification: () => () => {} } as unknown as RpcClient,
    { get: () => undefined, save: async () => {} },
    () => true,
    () => {},
  );
  store.applyThread({ id: "thread", cwd: "/workspace" });
  const tree = new ChangeTreeProvider(store);
  const identities = new Map<string, string | undefined>();
  function visit(parent?: ReviewNode) {
    for (const node of tree.getChildren(parent)) {
      assert.ok(
        node.kind !== "hunk" || parent?.kind === "file",
        "No orphan hunk",
      );
      assert.ok(parent?.kind !== "changeSet" || node.kind === "file");
      assert.deepEqual(tree.getParent(node), parent);
      if (parent) assert.equal(node.ref.changeSetId, parent.ref.changeSetId);
      const item = tree.getTreeItem(node);
      const key = refKey(node.ref);
      if (identities.has(key)) assert.equal(item.id, identities.get(key));
      identities.set(key, item.id);
      assert.ok(!String(item.label).includes("Turn"));
      visit(node);
    }
  }
  const first = snapshot();
  store.applySnapshot(first);
  assert.ok(tree.getChildren().every((node) => node.kind === "file"));
  visit();
  const originalFile = tree.getChildren()[0];
  const second = snapshot();
  second.id = "set-2";
  second.turnId = "turn-2";
  store.applySnapshot(second);
  assert.ok(tree.getChildren().every((node) => node.kind === "changeSet"));
  assert.equal(tree.getParent(originalFile)?.kind, "changeSet");
  visit();
  const changed = snapshot(1);
  changed.files[0].hunks[0].state = "accepted";
  changed.files[0].hunks[1].state = "reverted";
  store.applySnapshot(changed);
  visit();
  const secondAfter = store.all.find((set) => set.id === "set-2")!;
  assert.ok(
    secondAfter.files[0].hunks.every((hunk) => hunk.state === "pending"),
  );
  store.clearLocations();
  visit();
  store.clear();
  assert.deepEqual(tree.getChildren(), []);
  assert.deepEqual(tree.getChildren(originalFile), []);
  assert.equal(tree.getParent(originalFile), undefined);
  tree.dispose();
  store.dispose();
});
