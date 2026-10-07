import type { HunkLocationResult } from "../appServer/protocol";

export type EditorRange = {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
};
// VS Code ranges end at an exclusive Position. Whole lines end at the following
// line's column zero; the last line is bounded by its actual text length.
export function locationRange(
  result: Extract<HunkLocationResult, { status: "located" }>,
  lineCount: number,
  lineLength: (line: number) => number,
): EditorRange | undefined {
  if (result.kind === "filePresence") return undefined;
  const lastLine = Math.max(0, lineCount - 1);
  const startLine = Math.min(lastLine, Math.max(0, result.startLine - 1));
  if (result.kind === "deletionAnchor" || result.lineCount === 0) {
    return {
      startLine,
      startCharacter: 0,
      endLine: startLine,
      endCharacter: 0,
    };
  }
  const exclusiveEnd = Math.max(
    startLine,
    result.startLine - 1 + result.lineCount,
  );
  const endLine = Math.min(lastLine, exclusiveEnd);
  return {
    startLine,
    startCharacter: 0,
    endLine,
    endCharacter: exclusiveEnd > lastLine ? lineLength(lastLine) : 0,
  };
}
