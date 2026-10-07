//! Finalized turn review. All bulk operations visit Pending hunks only.

use crate::JsonSchema;
use crate::TS;
pub use codex_protocol::change_set::*;
use serde::Deserialize;
use serde::Serialize;

/// List finalized review snapshots retained by this loaded session, independently
/// of conversation history mode. This does not read persisted ChangeSets.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ChangeSetListParams {
    pub thread_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ChangeSetListResponse {
    pub change_sets: Vec<ChangeSet>,
}

/// Read session-local review data after turn completion or interruption.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ChangeSetReadParams {
    pub thread_id: String,
    pub turn_id: String,
}

/// Null means no finalized ChangeSet is retained (live turn, unloaded session,
/// restarted process, or a task that did not use the patch tracker).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ChangeSetReadResponse {
    pub change_set: Option<ChangeSet>,
}

/// Accept/revert every Pending hunk; terminal decisions are never reopened.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ChangeSetReviewParams {
    pub thread_id: String,
    pub turn_id: String,
    pub change_set_id: String,
}

/// Accept/revert Pending hunks in one file, preserving Accepted and Conflict.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ChangeSetFileReviewParams {
    pub thread_id: String,
    pub turn_id: String,
    pub change_set_id: String,
    pub file_id: String,
}

/// Accept/revert one Pending hunk. No client-supplied paths or patches execute.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ChangeSetHunkReviewParams {
    pub thread_id: String,
    pub turn_id: String,
    pub change_set_id: String,
    pub file_id: String,
    pub hunk_id: String,
}

/// Query live filesystem coordinates without changing review state or emitting
/// notifications. Historical oldStart/newStart remain unchanged.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ChangeSetHunkLocateParams {
    pub thread_id: String,
    pub turn_id: String,
    pub change_set_id: String,
    pub file_id: String,
    pub hunk_id: String,
}

/// Complete snapshot and individual outcomes, including partial success.
/// A rollback conflict is a normal result, not a JSON-RPC failure. Invalid IDs
/// and attempts to review a running thread are JSON-RPC errors.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ChangeSetReviewResponse {
    pub change_set: ChangeSet,
    pub results: Vec<ChangeSetHunkResult>,
}

/// Published once after a tracked turn finishes or is interrupted.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ChangeSetCreatedNotification {
    pub change_set: ChangeSet,
}

/// Publishes changed file/hunk decisions and their aggregate state together.
/// Full snapshots allow subscribers to update without re-diffing or polling.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ChangeSetUpdatedNotification {
    pub change_set: ChangeSet,
    pub results: Vec<ChangeSetHunkResult>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ClientRequest;
    use serde_json::json;

    #[test]
    fn hunk_locate_request_contract() {
        let wire = json!({
            "id": 7, "method": "changeSet/hunk/locate",
            "params": { "threadId": "t", "turnId": "u", "changeSetId": "s", "fileId": "f", "hunkId": "h" }
        });
        let request: ClientRequest = serde_json::from_value(wire.clone()).unwrap();
        assert!(
            matches!(&request, ClientRequest::ChangeSetHunkLocate { params, .. } if params.hunk_id == "h")
        );
        assert_eq!(serde_json::to_value(request).unwrap(), wire);
    }

    #[test]
    fn hunk_locate_response_contract_all_outcomes() {
        for wire in [
            json!({ "status": "located", "startLine": 73, "lineCount": 8, "kind": "content" }),
            json!({ "status": "located", "startLine": 42, "lineCount": 0, "kind": "deletionAnchor" }),
            json!({ "status": "located", "startLine": 1, "lineCount": 0, "kind": "filePresence" }),
            json!({ "status": "notPresent", "reason": "reverted" }),
            json!({ "status": "notPresent", "reason": "fileDeleted" }),
            json!({ "status": "notPresent", "reason": "fileMissing" }),
            json!({ "status": "conflict", "reason": "Target or context changed, or matches more than one location" }),
            json!({ "status": "unsupported", "reason": "Binary content is not reviewable" }),
        ] {
            let wire = json!({ "changeSetId": "s", "fileId": "f", "hunkId": "h", "path": "file:///workspace/a.rs", "result": wire });
            let response: ChangeSetHunkLocateResponse =
                serde_json::from_value(wire.clone()).unwrap();
            assert_eq!(serde_json::to_value(response).unwrap(), wire);
        }
    }
}
