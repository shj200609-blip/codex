//! Small, model-invisible review facts. No file images or diffs are persisted here.

use codex_protocol::change_set::ChangeReviewState;
use codex_protocol::change_set::ChangeSetFileKind;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ChangeReviewEvent {
    /// Stable identity of this authoritative operation and its changed outcomes.
    pub id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub change_set_id: String,
    pub revision: u32,
    pub scope: String,
    pub outcomes: Vec<ChangeReviewOutcome>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ChangeReviewOutcome {
    pub file_id: String,
    pub hunk_id: String,
    pub path: String,
    pub kind: ChangeSetFileKind,
    pub state: ChangeReviewState,
    /// Immutable diff-image coordinates, not current working-file positions.
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// Exact, short after-side edit text, if available. Never a full file attachment.
    pub removed_text: Option<String>,
    pub reason: Option<String>,
}
