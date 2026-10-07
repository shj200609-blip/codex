import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeSetStore } from "../src/changes/changeSetStore";
import { reference, type ReviewNode } from "../src/changes/models";
import type {
  RpcClient,
  Method,
  Params,
  Responses,
} from "../src/appServer/protocol";
import { snapshot } from "./fixtures";

// Exercise the actual command handlers in Node. Native rendering is tested
// separately in a real Extension Host, rather than asserted by this stub.
const handlers = new Map<string, (node?: ReviewNode) => Promise<void>>();
const warnings: string[] = [];
let documents: { isDirty: boolean; uri: { toString(): string } }[] = [];
type Choice = { set: ReturnType<typeof snapshot> };
let choose: (choices: Choice[]) => Promise<Choice | undefined> = async (c) =>
  c[0];
const stub = {
  Uri: { parse: (path: string) => ({ toString: () => path }) },
  workspace: {
    get textDocuments() {
      return documents;
    },
  },
  commands: {
    registerCommand: (
      id: string,
      handler: (node?: ReviewNode) => Promise<void>,
    ) => {
      handlers.set(id, handler);
      return { dispose() {} };
    },
  },
  window: {
    showWarningMessage: async (s: string) => {
      warnings.push(s);
    },
    showInformationMessage: async () => {},
    showErrorMessage: async () => {},
    showQuickPick: (choices: Choice[]) => choose(choices),
  },
};
const modules = require("node:module") as {
  _load: (request: string, ...args: unknown[]) => unknown;
};
const load = modules._load;
modules._load = function (request, ...args) {
  return request === "vscode" ? stub : load.call(this, request, ...args);
};
const { registerCommands } =
  require("../src/changes/commands") as typeof import("../src/changes/commands");
modules._load = load;
function fixture() {
  documents = [];
  warnings.length = 0;
  choose = async (c) => c[0];
  const calls: { method: Method; params: unknown }[] = [];
  let locate: Promise<unknown> | undefined;
  const client: RpcClient = {
    async request<M extends Method>(
      method: M,
      params: Params<M>,
    ): Promise<Responses[M]> {
      calls.push({ method, params });
      if (method === "changeSet/hunk/locate")
        return (await locate) as Responses[M];
      return { changeSet: snapshot(1), results: [] } as unknown as Responses[M];
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
  let selected: ReviewNode | undefined;
  let target: Promise<ReviewNode | undefined> = Promise.resolve(undefined);
  let opens = 0;
  registerCommands(
    store,
    client,
    {
      open: async () => {
        opens++;
      },
    } as never,
    async () => {},
    async () => {},
    { show() {} } as never,
    () => selected,
    () => target,
  );
  const node: ReviewNode = {
    kind: "hunk",
    ref: {
      ...reference(snapshot()),
      fileId: "file",
      hunkId: "A",
    },
  };
  return {
    store,
    calls,
    node,
    run: (name: string, n?: ReviewNode) =>
      handlers.get(`codexChanges.${name}`)!(n),
    select: (n: ReviewNode) => {
      selected = n;
    },
    active: (p: Promise<ReviewNode | undefined>) => {
      target = p;
    },
    setLocate: (p: Promise<unknown>) => {
      locate = p;
    },
    opened: () => opens,
  };
}
test("old inline actions for Accepted/Reverted/Conflict/Unsupported never issue a review RPC", async () => {
  for (const state of [
    "accepted",
    "reverted",
    "conflict",
    "unsupported",
  ] as const) {
    const f = fixture();
    const update = snapshot(1);
    update.files[0].hunks[0].state = state;
    f.store.applySnapshot(update);
    await f.run("acceptHunk", f.node);
    await f.run("revertHunk", f.node);
    assert.equal(f.calls.length, 0, state);
  }
});
test("dirty buffers block every review level without automatically saving", async () => {
  const f = fixture();
  documents = [
    { isDirty: true, uri: { toString: () => "file:///workspace/a.ts" } },
  ];
  for (const level of ["Hunk", "File", "All"])
    for (const action of ["accept", "revert"])
      await f.run(`${action}${level}`, f.node);
  assert.equal(f.calls.length, 0);
  assert.equal(documents[0].isDirty, true);
  assert.ok(
    warnings.every(
      (s) =>
        s ===
        "Save or discard editor changes before reviewing this Codex change.",
    ),
  );
  assert.equal(warnings.length, 6);
});
test("bulk actions use explicit targets or Tree selection, never the newest set", async () => {
  for (const explicit of [true, false]) {
    const f = fixture();
    const newer = snapshot();
    newer.id = "new-set";
    newer.turnId = "new-turn";
    f.store.applySnapshot(newer);
    f.select(f.node);
    await f.run(
      "revertAll",
      explicit ? { kind: "changeSet", ref: reference(newer) } : undefined,
    );
    assert.deepEqual(
      f.calls[0].params,
      reference(explicit ? newer : snapshot()),
    );
    assert.equal(f.calls[0].method, "changeSet/revert");
  }
});
test("multiple known sets still require explicit choice when only one remains pending", async () => {
  const f = fixture();
  const reviewed = snapshot();
  reviewed.id = "reviewed-set";
  reviewed.turnId = "reviewed-turn";
  reviewed.files[0].hunks.forEach((hunk) => {
    hunk.state = "accepted";
  });
  f.store.applySnapshot(reviewed);
  let choicesShown = 0;
  choose = async (choices) => {
    choicesShown++;
    assert.equal(choices.length, 1);
    assert.equal(choices[0].set.id, snapshot().id);
    return choices[0];
  };
  await f.run("acceptAll");
  assert.equal(choicesShown, 1);
  assert.equal(f.calls[0].method, "changeSet/accept");
  assert.deepEqual(f.calls[0].params, reference(snapshot()));
});
test("a decision from another client while the bulk picker is open invalidates its stale choice", async () => {
  const f = fixture();
  const second = snapshot();
  second.id = "set-2";
  second.turnId = "turn-2";
  f.store.applySnapshot(second);
  let finish!: () => void;
  choose = (choices) =>
    new Promise((done) => {
      finish = () => done(choices[0]);
    });
  const pending = f.run("acceptAll");
  const remote = snapshot(1);
  remote.files[0].hunks.forEach((h) => {
    h.state = "accepted";
  });
  f.store.applySnapshot(remote);
  finish();
  await pending;
  assert.equal(f.calls.length, 0);
});
test("selection of a terminal or expired set cannot fall through to another pending set", async () => {
  const f = fixture();
  const update = snapshot(1);
  update.files[0].hunks.forEach((h) => {
    h.state = "accepted";
  });
  f.store.applySnapshot(update);
  const second = snapshot();
  second.id = "set-2";
  second.turnId = "turn-2";
  f.store.applySnapshot(second);
  f.select(f.node);
  await f.run("revertAll");
  await f.run("acceptAll", {
    kind: "changeSet",
    ref: { ...reference(second), changeSetId: "expired" },
  });
  assert.equal(f.calls.length, 0);
});
test("a locator reply from a replaced revision/session cannot open a stale diff", async () => {
  for (const change of ["revision", "disconnect", "dispose"]) {
    const f = fixture();
    let done!: (value: unknown) => void;
    f.setLocate(
      new Promise((resolve) => {
        done = resolve;
      }),
    );
    const opening = f.run("openHunk", f.node);
    if (change === "revision") f.store.applySnapshot(snapshot(1));
    else if (change === "dispose") f.store.dispose();
    else f.store.clear();
    done({
      result: {
        status: "located",
        kind: "content",
        startLine: 73,
        lineCount: 4,
      },
    });
    await opening;
    assert.equal(f.opened(), 0);
  }
});

test("native editor toolbar revalidates an asynchronously chosen hunk", async () => {
  const f = fixture();
  let done!: (node: ReviewNode) => void;
  f.active(
    new Promise((resolve) => {
      done = resolve;
    }),
  );
  const pending = f.run("acceptCurrent");
  const update = snapshot(1);
  update.files[0].hunks[0].state = "accepted";
  f.store.applySnapshot(update);
  done(f.node);
  await pending;
  assert.equal(f.calls.length, 0);
  const second = fixture();
  second.active(Promise.resolve(second.node));
  await second.run("revertCurrent");
  assert.equal(second.calls[0].method, "changeSet/hunk/revert");
  assert.deepEqual(second.calls[0].params, second.node.ref);
});
