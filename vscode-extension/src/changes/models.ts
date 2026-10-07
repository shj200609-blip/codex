import type {
  ChangeSet,
  ChangeSetFile,
  ChangeHunk,
  ChangeSetReviewParams,
} from "../appServer/protocol";
export type ChangeSetRef = ChangeSetReviewParams;
export type FileRef = ChangeSetRef & { fileId: string };
export type HunkRef = FileRef & { hunkId: string };
export type ReviewNode =
  | { kind: "changeSet"; ref: ChangeSetRef }
  | { kind: "file"; ref: FileRef }
  | { kind: "hunk"; ref: HunkRef };
export function reference(set: ChangeSet): ChangeSetRef {
  return { threadId: set.threadId, turnId: set.turnId, changeSetId: set.id };
}
export function refKey(ref: ChangeSetRef | FileRef | HunkRef): string {
  return JSON.stringify([
    ref.threadId,
    ref.turnId,
    ref.changeSetId,
    "fileId" in ref ? ref.fileId : null,
    "hunkId" in ref ? ref.hunkId : null,
  ]);
}
export function hasPending(value: ChangeSet | ChangeSetFile): boolean {
  const files = "files" in value ? value.files : [value];
  return files.some(
    (file) =>
      !file.unsupportedReason &&
      file.state !== "unsupported" &&
      file.hunks.some((hunk) => hunk.state === "pending"),
  );
}
export function findFile(
  set: ChangeSet,
  ref: FileRef,
): ChangeSetFile | undefined {
  return set.files.find((file) => file.id === ref.fileId);
}
export function findHunk(
  file: ChangeSetFile,
  ref: HunkRef,
): ChangeHunk | undefined {
  return file.hunks.find((hunk) => hunk.id === ref.hunkId);
}
export function isReference(value: unknown): value is ChangeSetRef {
  return (
    !!value &&
    typeof value === "object" &&
    ["threadId", "turnId", "changeSetId"].every(
      (key) => typeof (value as Record<string, unknown>)[key] === "string",
    )
  );
}
