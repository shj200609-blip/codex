//! Git-independent, finalized turn changes for IDE review.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Aggregate review state. Mixed terminal decisions are `Reviewed`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum ChangeReviewState {
    Pending,
    Accepted,
    Reverted,
    Conflict,
    Reviewed,
    Unsupported,
}

/// Text file presence relative to its first mutation in the turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum ChangeSetFileKind {
    Added,
    Modified,
    Deleted,
}

/// An immutable diff identity with a mutable review decision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ChangeHunk {
    pub id: String,
    /// Historical baseline -> turn-final unified diff coordinates, never live
    /// filesystem positions. Nonempty starts are one-based; empty ranges use
    /// the preceding line number (zero at BOF). Use hunk/locate for navigation.
    pub old_start: u32,
    pub old_lines: u32,
    /// Historical turn-final coordinate, with the same unified diff convention.
    pub new_start: u32,
    pub new_lines: u32,
    /// Unified diff hunk, preserving line endings and missing-final-newline markers.
    pub patch: String,
    pub state: ChangeReviewState,
    /// Why rollback was refused; no forced rollback is available.
    pub conflict: Option<String>,
}

/// A file's first baseline and last exact Codex result, never Git HEAD.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ChangeSetFile {
    pub id: String,
    pub environment_id: String,
    /// Absolute path URI, consistent with executor environment addressing.
    pub path: String,
    pub change_type: ChangeSetFileKind,
    pub before_hash: Option<String>,
    pub after_hash: Option<String>,
    /// UTF-8 content for native IDE diffs. Null means absent or unsupported.
    pub before_content: Option<String>,
    pub after_content: Option<String>,
    pub state: ChangeReviewState,
    pub hunks: Vec<ChangeHunk>,
    /// Unsupported files are visible but cannot be accepted or reverted.
    pub unsupported_reason: Option<String>,
}

/// One finalized logical change set per turn. Review does not regenerate IDs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ChangeSet {
    pub id: String,
    /// Monotonic decision revision; clients can discard delayed notifications.
    pub revision: u32,
    pub thread_id: String,
    pub turn_id: String,
    pub state: ChangeReviewState,
    /// MVP coverage is `applyPatchOnly`: arbitrary shell/MCP writes are not tracked.
    pub coverage: String,
    /// Storage is `sessionMemory`: restart/unload loses review data.
    pub storage: String,
    pub files: Vec<ChangeSetFile>,
}

/// Per-hunk outcome, including unchanged accepted/reverted/conflicted hunks in bulk calls.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ChangeSetHunkResult {
    pub file_id: String,
    pub hunk_id: String,
    pub state: ChangeReviewState,
    pub changed: bool,
    pub message: Option<String>,
}

/// How a live range should be revealed in the current file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum CurrentHunkRangeKind {
    Content,
    DeletionAnchor,
    /// An empty created file has presence but no content lines.
    FilePresence,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum HunkNotPresentReason {
    Reverted,
    FileDeleted,
    FileMissing,
}

/// Read-only, point-in-time location; never changes review decisions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export_to = "v2/")]
pub enum HunkLocationResult {
    Located {
        /// One-based current line (consistent with protocol file locations).
        /// For an anchor, the insertion point before this line; EOF is N + 1.
        start_line: u32,
        /// Current after-side lines, excluding matching context. Zero for anchors.
        line_count: u32,
        kind: CurrentHunkRangeKind,
    },
    NotPresent {
        reason: HunkNotPresentReason,
    },
    /// Exact matching failed, was ambiguous, or the filesystem could not be read.
    Conflict {
        reason: String,
    },
    Unsupported {
        reason: String,
    },
}

/// Path uses the same absolute executor path URI as ChangeSetFile.path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ChangeSetHunkLocateResponse {
    pub change_set_id: String,
    pub file_id: String,
    pub hunk_id: String,
    pub path: String,
    pub result: HunkLocationResult,
}
