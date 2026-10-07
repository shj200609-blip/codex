import type { ChangeSet } from "../src/appServer/protocol";
export function snapshot(revision = 0): ChangeSet {
  return {
    id: "set",
    threadId: "thread",
    turnId: "turn",
    revision,
    state: "pending",
    coverage: "applyPatchOnly",
    storage: "sessionMemory",
    files: [
      {
        id: "file",
        path: "file:///workspace/a.ts",
        environmentId: "local",
        changeType: "modified",
        beforeHash: "before",
        afterHash: "after",
        beforeContent: "before\n",
        afterContent: "after\n",
        state: "pending",
        unsupportedReason: null,
        hunks: ["A", "B", "C"].map((id) => ({
          id,
          oldStart: 42,
          oldLines: 2,
          newStart: 43,
          newLines: 4,
          patch: "@@ patch @@",
          state: "pending",
          conflict: null,
        })),
      },
    ],
  };
}
