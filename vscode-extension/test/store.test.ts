import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ChangeSetStore, type Metadata } from "../src/changes/changeSetStore";
import { reference, type ChangeSetRef } from "../src/changes/models";
import { RpcError, ProtocolError } from "../src/appServer/errors";
import type {
  RpcClient,
  Method,
  Params,
  Responses,
  NotificationMethod,
  NotificationParams,
} from "../src/appServer/protocol";
import { snapshot } from "./fixtures";
class FakeRpc extends EventEmitter implements RpcClient {
  calls: { method: Method; params: unknown }[] = [];
  queue: (unknown | Error | (() => Promise<unknown>))[] = [];
  async request<M extends Method>(
    method: M,
    params: Params<M>,
  ): Promise<Responses[M]> {
    this.calls.push({ method, params });
    if (method === "thread/loaded/list" && !this.queue.length)
      return { data: [], nextCursor: null } as unknown as Responses[M];
    const value = this.queue.shift();
    if (value instanceof Error) throw value;
    return (
      typeof value === "function" ? await value() : value
    ) as Responses[M];
  }
  onNotification<M extends NotificationMethod>(
    method: M,
    listener: (params: NotificationParams<M>) => void,
  ): () => void {
    const handler = (params: unknown) =>
      listener(params as NotificationParams<M>);
    this.on(method, handler);
    return () => this.off(method, handler);
  }
}
function fixture(saved?: ChangeSetRef) {
  const client = new FakeRpc();
  let ref = saved;
  const metadata: Metadata = {
    get: () => ref,
    save: async (value) => {
      ref = value;
    },
  };
  const store = new ChangeSetStore(
    client,
    metadata,
    (path) =>
      path.startsWith("/workspace") || path.startsWith("file:///workspace/"),
    () => {},
  );
  store.applyThread({ id: "thread", cwd: "/workspace" });
  return { client, store, metadata };
}
test("created, updated, RPC and duplicate snapshots synchronize by revision", () => {
  const { client, store } = fixture();
  let events = 0;
  store.on("change", () => events++);
  client.emit("changeSet/created", { changeSet: snapshot() });
  const accepted = snapshot(1);
  accepted.files[0].hunks[0].state = "accepted";
  client.emit("changeSet/updated", { changeSet: accepted, results: [] });
  store.applyReview({ changeSet: accepted, results: [] });
  store.applySnapshot(snapshot(0));
  assert.equal(events, 2);
  assert.equal(store.pendingCount, 2);
  assert.equal(
    store.get({ ...reference(accepted), fileId: "file" } as ChangeSetRef)
      ?.files[0].hunks[0].state,
    "accepted",
  );
});
test("both RPC/notification orders retain partial rollback and terminal conflicts", async () => {
  for (const notificationFirst of [true, false]) {
    const { client, store } = fixture();
    store.applySnapshot(snapshot());
    const partial = snapshot(1);
    partial.state = partial.files[0].state = "conflict";
    partial.files[0].hunks[0].state = "reverted";
    partial.files[0].hunks[1].state = "conflict";
    partial.files[0].hunks[1].conflict = "User edited target";
    partial.files[0].hunks[2].state = "accepted";
    const response = {
      changeSet: partial,
      results: partial.files[0].hunks.map((hunk) => ({
        fileId: "file",
        hunkId: hunk.id,
        state: hunk.state,
        changed: true,
        message: hunk.conflict,
      })),
    };
    client.queue.push(response);
    if (notificationFirst) client.emit("changeSet/updated", response);
    const results = await store.review("changeSet/revert", reference(partial));
    if (!notificationFirst) client.emit("changeSet/updated", response);
    assert.equal(results.length, 3);
    assert.deepEqual(
      store.all[0].files[0].hunks.map((hunk) => hunk.state),
      ["reverted", "conflict", "accepted"],
    );
    assert.equal(store.all[0].state, "conflict");
  }
});
test("a late RPC snapshot cannot overwrite a newer notification", () => {
  const { store } = fixture();
  store.applySnapshot(snapshot(3));
  assert.deepEqual(
    store.applyReview({
      changeSet: snapshot(2),
      results: [
        {
          fileId: "file",
          hunkId: "A",
          state: "conflict",
          changed: true,
          message: "stale",
        },
      ],
    }),
    [],
  );
  assert.equal(store.all[0].revision, 3);
});
test("locator hints do not change authoritative review decisions", () => {
  const { store } = fixture();
  store.applySnapshot(snapshot());
  const ref = { ...reference(snapshot()), fileId: "file", hunkId: "A" };
  store.setLocation(ref, { status: "conflict", reason: "Shifted context" });
  assert.equal(store.all[0].files[0].hunks[0].state, "pending");
  store.applySnapshot(snapshot(1));
  assert.equal(store.location(ref), undefined);
});
test("restart clears snapshots and ignores already in-flight RPCs", async () => {
  const { store, client } = fixture();
  store.applySnapshot(snapshot());
  let resolve!: (value: unknown) => void;
  client.queue.push(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const read = store.readTurn("thread", "turn");
  store.clear();
  resolve({ changeSet: snapshot(2) });
  await read;
  assert.deepEqual(store.all, []);
});
test("reload clears metadata on null or missing session, but preserves it on a transport/protocol failure", async () => {
  for (const result of [
    { changeSet: null },
    new RpcError(-32600, "thread not found: thread"),
    new RpcError(-32602, "unknown turn"),
  ]) {
    const { store, client, metadata } = fixture(reference(snapshot()));
    client.queue.push(result);
    await store.restore();
    await new Promise((done) => setImmediate(done));
    assert.equal(metadata.get(), undefined);
    assert.equal(store.all.length, 0);
  }
  const { store, client, metadata } = fixture(reference(snapshot()));
  client.queue.push(new ProtocolError("timeout"));
  await assert.rejects(store.restore(), ProtocolError);
  assert.ok(metadata.get());
});
test("refresh actually calls read and discovers/subscribes only loaded workspace threads", async () => {
  const { store, client } = fixture();
  store.applySnapshot(snapshot());
  client.queue.push(
    { changeSet: snapshot(1) },
    { data: ["thread", "other"], nextCursor: null },
    { thread: { id: "thread", cwd: "/workspace" } },
    { thread: { id: "thread" } },
    { changeSets: [snapshot(1)] },
    { thread: { id: "other", cwd: "/elsewhere" } },
  );
  await store.refresh();
  assert.deepEqual(
    client.calls.map((call) => call.method),
    [
      "changeSet/read",
      "thread/loaded/list",
      "thread/read",
      "thread/resume",
      "changeSet/list",
      "thread/read",
    ],
  );
  assert.equal(store.all[0].revision, 1);
});
test("unsupported files remain visible; other workspaces and malformed snapshots are rejected", () => {
  const { store } = fixture();
  const set = snapshot();
  set.files[0].state = "unsupported";
  set.files[0].unsupportedReason = "Binary";
  set.files[0].hunks = [];
  assert.equal(store.applySnapshot(set), true);
  assert.equal(store.pendingCount, 0);
  const other = snapshot();
  other.files[0].path = "file:///elsewhere/a.ts";
  assert.equal(store.applySnapshot(other), false);
  assert.throws(
    () => store.applySnapshot({ ...set, revision: NaN }),
    ProtocolError,
  );
});
test("shared reconnect discovers two retained consecutive turns as distinct sets", async () => {
  const { store, client } = fixture();
  const first = snapshot(2);
  first.files[0].hunks[0].state = "accepted";
  const second = snapshot(1);
  second.id = "set-2";
  second.turnId = "turn-2";
  client.queue.push(
    { data: ["thread"], nextCursor: null },
    { thread: { id: "thread", cwd: "/workspace" } },
    { thread: { id: "thread" } },
    { changeSets: [second, first] },
  );
  await store.restore();
  assert.deepEqual(
    store.all.map((set) => set.id),
    ["set-2", "set"],
  );
  assert.equal(store.all[1].files[0].hunks[0].state, "accepted");
});

test("a new producer thread is subscribed after the reviewer is already connected", async () => {
  const { store, client } = fixture();
  client.queue.push(
    { thread: { id: "new", cwd: "/workspace" } },
    { changeSets: [{ ...snapshot(), threadId: "new" }] },
  );
  const changed = new Promise<void>((done) => store.once("change", done));
  client.emit("thread/started", { thread: { id: "new", cwd: "/workspace" } });
  await changed;
  assert.equal(store.all[0].threadId, "new");
  assert.deepEqual(
    client.calls.map((call) => call.method),
    ["thread/resume", "changeSet/list"],
  );
});

test("thread cwd isolates workspaces even if another producer edits a file here", async () => {
  const { store, client } = fixture();
  client.emit("thread/started", { thread: { id: "other", cwd: "/project-b" } });
  client.emit("changeSet/created", {
    changeSet: { ...snapshot(), threadId: "other" },
  });
  await Promise.resolve();
  assert.equal(store.all.length, 0);
  assert.equal(client.calls.length, 0);
  assert.equal(
    store.applySnapshot({ ...snapshot(), threadId: "unverified" }),
    false,
  );
});
