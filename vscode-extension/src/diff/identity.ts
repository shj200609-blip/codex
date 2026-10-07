import { isReference, type FileRef } from "../changes/models";
export type DiffSide = "baseline" | "current";
export function virtualIdentity(ref: FileRef, side: DiffSide): string {
  return JSON.stringify([
    ref.threadId,
    ref.turnId,
    ref.changeSetId,
    ref.fileId,
    side,
  ]);
}
export function decodeIdentity(query: string): {
  ref: FileRef;
  side: DiffSide;
} {
  const values: unknown = JSON.parse(query);
  if (
    !Array.isArray(values) ||
    values.length !== 5 ||
    !values.slice(0, 4).every((value) => typeof value === "string") ||
    !["baseline", "current"].includes(values[4])
  )
    throw new Error("Invalid Codex diff URI");
  const ref = {
    threadId: values[0],
    turnId: values[1],
    changeSetId: values[2],
    fileId: values[3],
  };
  if (!isReference(ref)) throw new Error("Invalid Codex diff reference");
  return { ref, side: values[4] };
}
