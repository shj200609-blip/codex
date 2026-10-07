import { EventEmitter } from "node:events";
import type {
  ChangeSet,
  ChangeSetHunkResult,
  ChangeSetReviewResponse,
  ReviewMethod,
  Params,
  RpcClient,
  HunkLocationResult,
  Responses,
} from "../appServer/protocol";
import { ProtocolError, isNotFound } from "../appServer/errors";
import { reference, refKey, type ChangeSetRef, type HunkRef } from "./models";

export interface Metadata {
  get(): ChangeSetRef | undefined;
  save(ref: ChangeSetRef | undefined): Promise<void>;
}
// Minimal envelope checks at the wire boundary. Generated types remain the schema.
function validateSnapshot(set: ChangeSet): void {
  if (
    !set ||
    typeof set.id !== "string" ||
    typeof set.threadId !== "string" ||
    typeof set.turnId !== "string" ||
    !Number.isSafeInteger(set.revision) ||
    set.revision < 0 ||
    !Array.isArray(set.files) ||
    set.files.some(
      (file) =>
        typeof file.id !== "string" ||
        typeof file.path !== "string" ||
        !Array.isArray(file.hunks),
    )
  ) {
    throw new ProtocolError("Malformed ChangeSet snapshot from App Server");
  }
}
export class ChangeSetStore extends EventEmitter {
  private workspaceThreads = new Map<string, boolean>();
  private subscriptions = new Map<string, Promise<void>>();
  private snapshots = new Map<string, ChangeSet>();
  private locations = new Map<string, HunkLocationResult>();
  private unsubscribe: (() => void)[];
  private metadataWrites: Promise<void> = Promise.resolve();
  private generation = 0;
  constructor(
    private readonly client: RpcClient,
    private readonly metadata: Metadata,
    private readonly belongsToWorkspace: (cwd: string) => boolean,
    private readonly log: (message: string) => void,
  ) {
    super();
    this.unsubscribe = [
      client.onNotification("thread/started", ({ thread }) => {
        if (this.applyThread(thread))
          void this.subscribeThread(thread.id).catch((error) =>
            this.log(`Thread subscription: ${String(error)}`),
          );
      }),
      client.onNotification(
        "thread/settings/updated",
        ({ threadId, threadSettings }) => {
          if (this.applyThread({ id: threadId, cwd: threadSettings.cwd }))
            void this.subscribeThread(threadId).catch((error) =>
              this.log(String(error)),
            );
        },
      ),
      client.onNotification("changeSet/created", ({ changeSet }) => {
        void this.receiveSnapshot(changeSet).catch((error) =>
          this.log(String(error)),
        );
      }),
      client.onNotification("changeSet/updated", (response) => {
        void this.receiveSnapshot(response.changeSet).catch((error) =>
          this.log(String(error)),
        );
      }),
      // Created is normally sufficient. Reading at completion also covers a subscription race.
      client.onNotification("turn/completed", ({ threadId, turn }) => {
        void this.readTurn(threadId, turn.id).catch((error) =>
          this.log(`Turn review read: ${String(error)}`),
        );
      }),
    ];
  }
  // Thread cwd is authoritative. File paths alone cannot associate a producer with a workspace.
  applyThread(thread: { id: string; cwd: string }): boolean {
    const belongs = this.belongsToWorkspace(thread.cwd);
    this.workspaceThreads.set(thread.id, belongs);
    if (!belongs) {
      let changed = false;
      for (const [key, set] of this.snapshots) {
        if (set.threadId === thread.id) {
          this.snapshots.delete(key);
          changed = true;
        }
      }
      if (changed) {
        this.locations.clear();
        this.emit("change");
      }
    }
    return belongs;
  }
  private async ensureWorkspaceThread(threadId: string): Promise<boolean> {
    if (this.workspaceThreads.has(threadId))
      return this.workspaceThreads.get(threadId)!;
    const generation = this.generation;
    const { thread } = await this.client.request("thread/read", {
      threadId,
      includeTurns: false,
    });
    return generation === this.generation && this.applyThread(thread);
  }
  private async receiveSnapshot(set: ChangeSet): Promise<void> {
    validateSnapshot(set);
    if (this.workspaceThreads.get(set.threadId) === true) {
      this.applySnapshot(set);
    } else if (await this.ensureWorkspaceThread(set.threadId)) {
      this.applySnapshot(set);
    }
  }
  private subscribeThread(threadId: string): Promise<void> {
    const existing = this.subscriptions.get(threadId);
    if (existing) return existing;
    const generation = this.generation;
    const subscription = (async () => {
      // Warm resume subscribes to the existing Core; it neither starts nor owns a turn.
      await this.client.request("thread/resume", {
        threadId,
        excludeTurns: true,
      });
      if (generation !== this.generation) return;
      const { changeSets } = await this.client.request("changeSet/list", {
        threadId,
      });
      if (generation !== this.generation) return;
      for (const set of changeSets) this.applySnapshot(set);
    })();
    this.subscriptions.set(threadId, subscription);
    void subscription
      .finally(() => {
        if (this.subscriptions.get(threadId) === subscription)
          this.subscriptions.delete(threadId);
      })
      .catch(() => {});
    return subscription;
  }
  get all(): ChangeSet[] {
    return [...this.snapshots.values()];
  }
  get(ref: ChangeSetRef): ChangeSet | undefined {
    return this.snapshots.get(
      refKey({
        threadId: ref.threadId,
        turnId: ref.turnId,
        changeSetId: ref.changeSetId,
      }),
    );
  }
  get pendingCount(): number {
    return this.all.reduce(
      (sum, set) =>
        sum +
        set.files.reduce(
          (n, file) =>
            n + file.hunks.filter((hunk) => hunk.state === "pending").length,
          0,
        ),
      0,
    );
  }
  location(ref: HunkRef): HunkLocationResult | undefined {
    return this.locations.get(refKey(ref));
  }
  setLocation(ref: HunkRef, result: HunkLocationResult): void {
    this.locations.set(refKey(ref), result);
    this.emit("change");
  }
  clearLocations(): void {
    if (this.locations.size) {
      this.locations.clear();
      this.emit("change");
    }
  }
  applySnapshot(set: ChangeSet): boolean {
    validateSnapshot(set);
    // Notifications for other workspaces must not appear in this window.
    if (
      this.workspaceThreads.get(set.threadId) !== true ||
      !set.files.some((file) => this.belongsToWorkspace(file.path))
    )
      return false;
    const key = refKey(reference(set));
    const current = this.snapshots.get(key);
    if (current && current.revision >= set.revision) return false;
    this.snapshots.set(key, set);
    for (const file of set.files)
      for (const hunk of file.hunks)
        this.locations.delete(
          refKey({ ...reference(set), fileId: file.id, hunkId: hunk.id }),
        );
    this.persist(reference(set));
    this.emit("change");
    return true;
  }
  applyReview(response: ChangeSetReviewResponse): ChangeSetHunkResult[] {
    if (!response || !Array.isArray(response.results))
      throw new ProtocolError("Malformed ChangeSet review result");
    const applied = this.applySnapshot(response.changeSet);
    // Snapshots carry actual states; per-hunk outcomes are for explanations, never guessed mutations.
    return applied ||
      this.get(reference(response.changeSet))?.revision ===
        response.changeSet.revision
      ? response.results
      : [];
  }
  async review<M extends ReviewMethod>(
    method: M,
    params: Params<M>,
  ): Promise<ChangeSetHunkResult[]> {
    const generation = this.generation;
    const response = await this.client.request(method, params);
    return generation === this.generation ? this.applyReview(response) : [];
  }
  private persist(ref: ChangeSetRef | undefined): void {
    this.metadataWrites = this.metadataWrites
      .then(() => this.metadata.save(ref))
      .catch((error) => this.log(`Workspace reference: ${String(error)}`));
  }
  private remove(ref: ChangeSetRef): void {
    if (this.snapshots.delete(refKey(ref))) this.emit("change");
    const stored = this.metadata.get();
    if (stored && refKey(stored) === refKey(ref)) this.persist(undefined);
  }
  async readTurn(
    threadId: string,
    turnId: string,
    expected?: ChangeSetRef,
  ): Promise<void> {
    const generation = this.generation;
    if (
      this.workspaceThreads.get(threadId) !== true &&
      !(await this.ensureWorkspaceThread(threadId))
    )
      return;
    if (generation !== this.generation) return;
    const { changeSet } = await this.client.request("changeSet/read", {
      threadId,
      turnId,
    });
    if (generation !== this.generation) return;
    if (changeSet && (!expected || changeSet.id === expected.changeSetId))
      this.applySnapshot(changeSet);
    else if (expected) this.remove(expected);
  }
  async refresh(): Promise<void> {
    this.clearLocations();
    for (const set of this.all) {
      const ref = reference(set);
      try {
        await this.readTurn(ref.threadId, ref.turnId, ref);
      } catch (error) {
        if (isNotFound(error)) this.remove(ref);
        else throw error;
      }
    }
    await this.discover();
  }
  async restore(): Promise<void> {
    const ref = this.metadata.get();
    if (ref) {
      try {
        await this.readTurn(ref.threadId, ref.turnId, ref);
      } catch (error) {
        if (isNotFound(error)) this.persist(undefined);
        else throw error;
      }
    }
    await this.discover();
  }
  private async discover(): Promise<void> {
    const generation = this.generation;
    let cursor: string | null = null;
    do {
      const loaded: Responses["thread/loaded/list"] = await this.client.request(
        "thread/loaded/list",
        { cursor, limit: 100 },
      );
      if (generation !== this.generation) return;
      for (const threadId of loaded.data) {
        try {
          const { thread } = await this.client.request("thread/read", {
            threadId,
            includeTurns: false,
          });
          if (generation !== this.generation) return;
          if (!this.applyThread(thread)) continue;
          await this.subscribeThread(threadId);
        } catch (error) {
          if (isNotFound(error))
            this.log(`Thread disappeared during discovery: ${threadId}`);
          else throw error;
        }
      }
      cursor = loaded.nextCursor;
    } while (cursor);
  }
  clear(): void {
    this.generation++;
    this.workspaceThreads.clear();
    this.subscriptions.clear();
    this.snapshots.clear();
    this.locations.clear();
    this.emit("change");
  }
  dispose(): void {
    this.generation++;
    this.workspaceThreads.clear();
    this.subscriptions.clear();
    this.snapshots.clear();
    this.locations.clear();
    this.unsubscribe.forEach((unsubscribe) => unsubscribe());
    this.removeAllListeners();
  }
}
