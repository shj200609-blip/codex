import { EventEmitter } from "node:events";
import type {
  ChangeSetFile,
  RpcClient,
  HunkLocationResult,
} from "../appServer/protocol";
import { ChangeSetStore } from "../changes/changeSetStore";
import { changeGroupLabel, filePresentation } from "../changes/changeTreeItems";
import {
  hasPending,
  reference,
  type FileRef,
  type ReviewNode,
} from "../changes/models";

export const SAVE_BEFORE_REVIEW =
  "Save or discard editor changes before reviewing this Codex change.";

export type InlineAction = {
  line: number;
  title: string;
  tooltip: string;
  command: string;
  node: ReviewNode;
  range?: { startLine: number; endLine: number };
  groupLabel?: string;
};
export interface InlineDocument {
  lineCount: number;
  matches(ref: FileRef, file: ChangeSetFile): boolean;
  dirty(file: ChangeSetFile): boolean;
  // Includes document version, disposal and cancellation, not just disk state.
  isCurrent(): boolean;
}

// Presentation only. Decisions stay in the shared store; every hunk position
// comes from Core. No historical coordinates, matching or rollback here.
export class InlineReview extends EventEmitter {
  private epoch = 0;
  private disposed = false;
  private readonly changed = () => this.invalidate();
  constructor(
    private readonly store: ChangeSetStore,
    private readonly client: RpcClient,
    private readonly log: (message: string) => void,
  ) {
    super();
    store.on("change", this.changed);
  }
  invalidate(): void {
    this.epoch++;
    if (!this.disposed) this.emit("change");
  }
  async actions(document: InlineDocument): Promise<InlineAction[]> {
    const epoch = this.epoch;
    const current = () =>
      !this.disposed && epoch === this.epoch && document.isCurrent();
    const groups = this.store.all.flatMap((set) =>
      set.files.flatMap((file) => {
        const ref = { ...reference(set), fileId: file.id };
        return document.matches(ref, file) ? [{ set, file, ref }] : [];
      }),
    );
    const result = await Promise.all(
      groups.map(async ({ set, file, ref }) => {
        const fileNode: ReviewNode = { kind: "file", ref };
        const action = (
          line: number,
          title: string,
          node: ReviewNode,
          command = "",
          explanation = "",
        ): InlineAction => ({
          line,
          title,
          command,
          node,
          groupLabel: changeGroupLabel(this.store.all, ref),
          tooltip: [
            title,
            explanation,
            node.kind === "file" ? filePresentation(file, "").tooltip : "",
            changeGroupLabel(this.store.all, ref),
            `Thread: ${set.threadId}`,
            `Turn: ${set.turnId}`,
            `ChangeSet: ${set.id}`,
            `File: ${file.id}`,
            node.kind === "hunk" ? `Hunk: ${node.ref.hunkId}` : "",
            `Revision: ${set.revision}`,
          ]
            .filter(Boolean)
            .join("\n"),
        });
        // This is a file-level header, never a claimed hunk location.
        if (document.dirty(file))
          return [action(0, `⚠ ${SAVE_BEFORE_REVIEW}`, fileNode)];
        const unsupported =
          file.state === "unsupported" || !!file.unsupportedReason;
        const header: InlineAction[] = [];
        if (unsupported)
          return [
            action(
              0,
              "? Unsupported",
              fileNode,
              "",
              file.unsupportedReason ?? "This file cannot be reviewed.",
            ),
          ];
        const reverted = file.hunks.filter(
          (hunk) => hunk.state === "reverted",
        ).length;
        if (reverted)
          header.push(
            action(
              0,
              reverted === 1
                ? "↶ Reverted"
                : `↶ Reverted · ${reverted} changes`,
              fileNode,
              "",
              "Reverted content has no live hunk position. This summary appears at the file header.",
            ),
          );
        if (hasPending(file))
          header.push(
            action(0, "✓ Accept File", fileNode, "codexChanges.acceptFile"),
            action(0, "↶ Revert File", fileNode, "codexChanges.revertFile"),
          );
        const hunks = await Promise.all(
          file.hunks.map(async (hunk) => {
            const node: ReviewNode = {
              kind: "hunk",
              ref: { ...ref, hunkId: hunk.id },
            };
            let location: HunkLocationResult;
            try {
              location = (
                await this.client.request("changeSet/hunk/locate", node.ref)
              ).result;
            } catch (error) {
              if (current()) this.log(`Inline hunk location: ${String(error)}`);
              // Never leave review actions attached to a guessed/stale line.
              return [
                action(
                  0,
                  "Location unavailable · Open Diff",
                  node,
                  "codexChanges.openHunk",
                  "Reconnect or Refresh before reviewing.",
                ),
              ];
            }
            if (!current() || document.dirty(file)) return [];
            // Reverted content no longer has a live position. The file/Tree progress
            // retains its decision; its former inline buttons disappear.
            if (
              location.status === "notPresent" &&
              location.reason === "reverted"
            )
              return [];
            const presence =
              location.status === "located" && location.kind === "filePresence";
            const absentDeletion =
              location.status === "notPresent" &&
              location.reason === "fileDeleted" &&
              file.changeType === "deleted";
            const located = location.status === "located";
            const line =
              location.status === "located" && !presence
                ? Math.max(
                    0,
                    Math.min(document.lineCount - 1, location.startLine - 1),
                  )
                : 0;
            const explanation =
              location.status === "located"
                ? `Core locator: ${location.kind}`
                : location.status === "notPresent"
                  ? `No live content position: ${location.reason}`
                  : location.reason;
            const stateTitle =
              hunk.state === "pending"
                ? location.status === "conflict"
                  ? "⚠ Location conflict"
                  : location.status === "unsupported"
                    ? "? Unsupported"
                    : "Location unavailable"
                : hunk.state === "accepted"
                  ? "✓ Accepted"
                  : hunk.state === "reverted"
                    ? "↶ Reverted"
                    : hunk.state === "conflict"
                      ? "⚠ Conflict"
                      : hunk.state === "unsupported"
                        ? "? Unsupported"
                        : "✓ Reviewed";
            const status = action(line, stateTitle, node, "", explanation);
            // Decoration bounds also come from Core, never hunk old/new starts.
            if (location.status === "located" && !presence)
              status.range = {
                startLine: line,
                endLine: Math.min(
                  document.lineCount - 1,
                  line + Math.max(0, location.lineCount - 1),
                ),
              };
            if (hunk.state === "pending" && (located || absentDeletion)) {
              const accept = action(
                line,
                "✓ Accept Change",
                node,
                "codexChanges.acceptHunk",
                presence || absentDeletion
                  ? `Review file presence. ${explanation}`
                  : explanation,
              );
              accept.range = status.range;
              return [
                accept,
                action(
                  line,
                  "↶ Revert Change",
                  node,
                  "codexChanges.revertHunk",
                  presence || absentDeletion
                    ? `Review file presence. ${explanation}`
                    : explanation,
                ),
              ];
            }
            if (hunk.state === "accepted" || hunk.state === "reviewed")
              return [status];
            // Conflict/Unsupported and unresolved locators are read-only. A document
            // header at line zero explicitly avoids implying a located target region.
            return [
              status,
              action(
                line,
                "Open Diff",
                node,
                "codexChanges.openHunk",
                explanation,
              ),
            ];
          }),
        );
        return [...header, ...hunks.flat()];
      }),
    );
    return current() ? result.flat() : [];
  }
  dispose(): void {
    this.disposed = true;
    this.epoch++;
    this.store.off("change", this.changed);
    this.removeAllListeners();
  }
}
