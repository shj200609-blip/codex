import type {
  ChangeReviewState,
  ChangeSet,
  ChangeSetFile,
  ChangeHunk,
  HunkLocationResult,
} from "../appServer/protocol";
import { hasPending, type ChangeSetRef } from "./models";

const icons: Record<ChangeReviewState, string> = {
  pending: "",
  accepted: "check",
  reverted: "discard",
  conflict: "warning",
  unsupported: "question",
  reviewed: "check-all",
};
const labels: Record<ChangeReviewState, string> = {
  pending: "Pending",
  accepted: "Accepted",
  reverted: "Reverted",
  conflict: "Conflict",
  unsupported: "Unsupported",
  reviewed: "Reviewed",
};
function progress(hunks: ChangeHunk[]): string {
  const reviewed = hunks.filter(
    (hunk) => hunk.state === "accepted" || hunk.state === "reverted",
  ).length;
  return hunks.length ? ` · ${reviewed} / ${hunks.length} reviewed` : "";
}
export function changeGroupLabel(sets: ChangeSet[], ref: ChangeSetRef): string {
  const index = sets.findIndex(
    (set) =>
      set.id === ref.changeSetId &&
      set.threadId === ref.threadId &&
      set.turnId === ref.turnId,
  );
  return sets.length > 1 && index >= 0 ? `Changes ${index + 1}` : "Changes";
}

// Read only the unified patch supplied by Core. This is a display excerpt,
// never a new diff, a content matcher or a source of live coordinates.
export function hunkPreview(hunk: ChangeHunk): string {
  const lines = hunk.patch.split(/\r?\n/);
  const header = lines.findIndex((line) => line.startsWith("@@"));
  if (header < 0) return "";
  const excerpt = (prefix: string) =>
    lines
      .slice(header + 1)
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(1).replace(/\s+/g, " ").trim())
      .find(Boolean);
  const text = excerpt("+") ?? excerpt("-") ?? "";
  return Array.from(text).length > 56
    ? Array.from(text).slice(0, 55).join("") + "…"
    : text;
}

export function hunkSummary(hunk: ChangeHunk): string {
  return (
    [
      hunk.newLines ? `+${hunk.newLines}` : "",
      hunk.oldLines ? `−${hunk.oldLines}` : "",
    ]
      .filter(Boolean)
      .join(" ") || "Empty file"
  );
}
export type Presentation = {
  label: string;
  description: string;
  icon: string;
  contextValue: string;
  canAccept: boolean;
  canRevert: boolean;
  tooltip: string;
};
export function hunkPresentation(
  hunk: ChangeHunk,
  location?: HunkLocationResult,
): Presentation {
  const hint =
    location?.status === "conflict"
      ? `Location conflict: ${location.reason}`
      : location?.status === "unsupported"
        ? `Unsupported location: ${location.reason}`
        : "";
  return {
    label: hunkSummary(hunk),
    description: hunkPreview(hunk),
    icon: hint ? "warning" : icons[hunk.state],
    contextValue: `hunk:${hunk.state}`,
    canAccept: hunk.state === "pending",
    canRevert: hunk.state === "pending",
    tooltip: [
      labels[hunk.state],
      hunk.conflict,
      hint,
      hunkPreview(hunk),
      "Open Diff uses the current position reported by Codex Core.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
export function filePresentation(
  file: ChangeSetFile,
  displayPath: string,
): Presentation {
  const pending = hasPending(file);
  return {
    label: displayPath,
    description:
      file.state === "conflict" || file.state === "unsupported"
        ? labels[file.state]
        : file.changeType === "added"
          ? "Added"
          : file.changeType === "deleted"
            ? "Deleted"
            : `${file.hunks.length} ${file.hunks.length === 1 ? "change" : "changes"}`,
    icon:
      icons[file.state] ||
      (file.changeType === "added"
        ? "diff-added"
        : file.changeType === "deleted"
          ? "diff-removed"
          : "file"),
    contextValue: `file:${file.state}:${pending ? "pending" : "terminal"}`,
    canAccept: pending,
    canRevert: pending,
    tooltip: [
      file.path,
      `${file.changeType} · ${labels[file.state]}${progress(file.hunks)}`,
      file.unsupportedReason,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
export function setPresentation(
  set: ChangeSet,
  label = "Changes",
): Presentation {
  const pending = hasPending(set);
  return {
    label,
    description: `${set.files.length} ${set.files.length === 1 ? "file" : "files"}`,
    icon: icons[set.state] || "diff",
    contextValue: `changeSet:${set.state}:${pending ? "pending" : "terminal"}`,
    canAccept: pending,
    canRevert: pending,
    tooltip: `${labels[set.state]}${progress(set.files.flatMap((file) => file.hunks))}\nThread: ${set.threadId}\nTurn: ${set.turnId}\nChangeSet: ${set.id}\nRevision: ${set.revision}\nCoverage: ${set.coverage}\nStorage: ${set.storage}`,
  };
}
