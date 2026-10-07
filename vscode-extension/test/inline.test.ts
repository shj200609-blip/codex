import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeSetStore } from "../src/changes/changeSetStore";
import {
  InlineReview,
  SAVE_BEFORE_REVIEW,
  type InlineDocument,
} from "../src/review/inlineReview";
import type {
  RpcClient,
  HunkLocationResult,
  Method,
  Params,
  Responses,
} from "../src/appServer/protocol";
import { snapshot } from "./fixtures";

function fixture() {
  const calls: { method: string; params: unknown }[] = [];
  const locations = new Map<string, HunkLocationResult>([
    ["A", { status: "located", kind: "content", startLine: 73, lineCount: 4 }],
    [
      "B",
      {
        status: "located",
        kind: "deletionAnchor",
        startLine: 101,
        lineCount: 0,
      },
    ],
    [
      "C",
      { status: "located", kind: "filePresence", startLine: 1, lineCount: 0 },
    ],
  ]);
  let wait: Promise<void> | undefined;
  const client: RpcClient = {
    async request<M extends Method>(
      method: M,
      params: Params<M>,
    ): Promise<Responses[M]> {
      calls.push({ method, params });
      if (wait) await wait;
      assert.equal(
        method,
        "changeSet/hunk/locate",
        "Inline UI may only locate, never match/review itself",
      );
      const key = (params as { hunkId: string }).hunkId;
      const result = locations.get(key);
      if (!result) throw new Error("Locator unavailable");
      return { result } as Responses[M];
    },
    onNotification: () => () => {},
  };
  const store = new ChangeSetStore(
    client,
    { get: () => undefined, save: async () => {} },
    () => true,
    () => {},
  );
  store.applyThread({ id: "thread", cwd: "/workspace" });
  store.applySnapshot(snapshot());
  const inline = new InlineReview(store, client, () => {});
  let dirty = false,
    current = true;
  const document: InlineDocument = {
    lineCount: 100,
    matches: (_, file) => file.path === "file:///workspace/a.ts",
    dirty: () => dirty,
    isCurrent: () => current,
  };
  return {
    calls,
    locations,
    client,
    store,
    inline,
    document,
    setDirty: (value: boolean) => {
      dirty = value;
    },
    cancel: () => {
      current = false;
    },
    delay: (value: Promise<void>) => {
      wait = value;
    },
  };
}
test("inline actions use Core live positions, deletion/EOF bounds and stable complete references", async () => {
  const f = fixture();
  const actions = await f.inline.actions(f.document);
  const accept = actions.filter((a) => a.command === "codexChanges.acceptHunk");
  assert.deepEqual(
    accept.map((a) => a.line),
    [72, 99, 0],
  );
  assert.deepEqual(accept[0].node, {
    kind: "hunk",
    ref: {
      threadId: "thread",
      turnId: "turn",
      changeSetId: "set",
      fileId: "file",
      hunkId: "A",
    },
  });
  const frames = actions.filter((a) => a.range);
  assert.deepEqual(
    frames.map((a) => a.range),
    [
      { startLine: 72, endLine: 75 },
      { startLine: 99, endLine: 99 },
    ],
  );
  assert.equal(f.calls.length, 3);
  assert.ok(
    actions.every((a) => !/Turn|Pending|Codex ·|thread|turn/.test(a.title)),
  );
  assert.equal(accept[0].title, "✓ Accept Change");
  assert.ok(accept[0].tooltip.includes("Turn: turn"));
  assert.equal(f.store.all[0].revision, 0, "Rendering is read-only");
});
test("server decisions replace inline actions; reverted content has no historical anchor", async () => {
  const f = fixture();
  const updated = snapshot(1);
  updated.files[0].hunks[0].state = "accepted";
  updated.files[0].hunks[1].state = "reverted";
  updated.files[0].hunks[2].state = "conflict";
  updated.files[0].state = "conflict";
  f.locations.set("B", { status: "notPresent", reason: "reverted" });
  f.locations.set("C", { status: "conflict", reason: "User edited target" });
  f.store.applySnapshot(updated);
  const actions = await f.inline.actions(f.document);
  assert.ok(actions.some((a) => a.title.includes("Accepted") && a.line === 72));
  assert.ok(
    actions.some((a) => a.title.includes("Conflict") && a.command === ""),
  );
  assert.ok(actions.some((a) => a.tooltip.includes("2 / 3 reviewed")));
  assert.ok(
    actions.some(
      (a) =>
        a.title === "↶ Reverted" &&
        a.line === 0 &&
        a.node.kind === "file" &&
        !a.range,
    ),
  );
  assert.ok(!actions.some((a) => /accept|revert/i.test(a.command)));
  assert.ok(
    !actions.some((a) => a.node.kind === "hunk" && a.node.ref.hunkId === "B"),
  );
});
test("a newer revision or saved edit during locate discards the entire stale action response", async () => {
  for (const event of [
    "revision",
    "saved edit",
    "disconnect",
    "dispose",
    "cancel",
  ]) {
    const f = fixture();
    let resolve!: () => void;
    f.delay(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = f.inline.actions(f.document);
    if (event === "revision") f.store.applySnapshot(snapshot(1));
    if (event === "saved edit") f.inline.invalidate();
    if (event === "disconnect") f.store.clear();
    if (event === "dispose") f.inline.dispose();
    if (event === "cancel") f.cancel();
    resolve();
    assert.deepEqual(await pending, [], event);
  }
});
test("dirty documents expose only a save/discard message and never request disk coordinates", async () => {
  const f = fixture();
  f.setDirty(true);
  const actions = await f.inline.actions(f.document);
  assert.equal(actions.length, 1);
  assert.ok(actions[0].title.includes(SAVE_BEFORE_REVIEW));
  assert.equal(actions[0].command, "");
  assert.equal(f.calls.length, 0);
});
test("saved insertion and partial rollback use a fresh locator, not historical starts", async () => {
  const f = fixture();
  await f.inline.actions(f.document);
  f.locations.set("A", {
    status: "located",
    kind: "content",
    startLine: 93,
    lineCount: 4,
  });
  f.inline.invalidate();
  const afterInsert = await f.inline.actions(f.document);
  assert.equal(
    afterInsert.find((a) => a.command === "codexChanges.acceptHunk")!.line,
    92,
  );
  const updated = snapshot(1);
  updated.files[0].hunks[0].state = "reverted";
  f.locations.set("A", { status: "notPresent", reason: "reverted" });
  f.locations.set("B", {
    status: "located",
    kind: "deletionAnchor",
    startLine: 80,
    lineCount: 0,
  });
  f.store.applySnapshot(updated);
  assert.equal(
    (await f.inline.actions(f.document)).find(
      (a) => a.command === "codexChanges.revertHunk",
    )!.line,
    79,
  );
});
test("unlocated/unsupported hunks have no speculative inline review buttons", async () => {
  const f = fixture();
  f.locations.set("A", { status: "conflict", reason: "Edited" });
  f.locations.set("B", { status: "unsupported", reason: "Binary" });
  f.locations.delete("C");
  const actions = await f.inline.actions(f.document);
  assert.ok(!actions.some((a) => /acceptHunk|revertHunk/.test(a.command)));
  assert.ok(
    actions.filter((a) => a.node.kind === "hunk").every((a) => a.line === 0),
  );
  const unsupported = snapshot(1);
  unsupported.files[0].state = "unsupported";
  unsupported.files[0].unsupportedReason = "Binary file";
  f.store.applySnapshot(unsupported);
  f.calls.length = 0;
  assert.ok(
    !(await f.inline.actions(f.document)).some((a) =>
      /accept|revert/i.test(a.command),
    ),
  );
  assert.equal(f.calls.length, 0);
});
test("deleted-file absence is an explicit file-presence action, never a historical line", async () => {
  const f = fixture();
  const set = snapshot(1);
  set.files[0].changeType = "deleted";
  set.files[0].hunks = [set.files[0].hunks[0]];
  f.locations.set("A", { status: "notPresent", reason: "fileDeleted" });
  f.store.applySnapshot(set);
  const actions = await f.inline.actions(f.document);
  assert.ok(actions.every((a) => a.line === 0));
  assert.ok(actions.some((a) => a.command === "codexChanges.revertHunk"));
  assert.ok(actions.some((a) => a.tooltip.includes("file presence")));
});
test("two sets for the same path expose separate file/hunk targets and progress", async () => {
  const f = fixture();
  const second = snapshot();
  second.id = "set-2";
  second.turnId = "turn-2";
  f.store.applySnapshot(second);
  const actions = await f.inline.actions(f.document);
  const files = actions.filter((a) => a.command === "codexChanges.revertFile");
  assert.deepEqual(
    files.map((a) => a.node.ref.changeSetId),
    ["set", "set-2"],
  );
  assert.ok(actions.some((a) => a.groupLabel === "Changes 2"));
  assert.ok(actions.every((a) => !a.title.includes("turn-2")));
  assert.ok(actions.some((a) => a.tooltip.includes("turn-2")));
  assert.equal(
    actions.filter((a) => a.command === "codexChanges.acceptHunk").length,
    6,
  );
});
