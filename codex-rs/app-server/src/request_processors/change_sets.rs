use super::thread_processor::ThreadRequestProcessor;
use crate::error_code::invalid_params;
use crate::outgoing_message::ThreadScopedOutgoingMessageSender;
use codex_app_server_protocol::ChangeSetHunkLocateParams;
use codex_app_server_protocol::ChangeSetListParams;
use codex_app_server_protocol::ChangeSetListResponse;
use codex_app_server_protocol::ChangeSetReadParams;
use codex_app_server_protocol::ChangeSetReadResponse;
use codex_app_server_protocol::ChangeSetReviewResponse;
use codex_app_server_protocol::ChangeSetUpdatedNotification;
use codex_app_server_protocol::ClientResponsePayload;
use codex_app_server_protocol::JSONRPCErrorError;
use codex_app_server_protocol::ServerNotification;
use codex_core::change_set::ReviewAction;
use codex_core::change_set::ReviewSelection;
use std::sync::Arc;

impl ThreadRequestProcessor {
    pub(crate) async fn change_set_list(
        &self,
        params: ChangeSetListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        let (_, thread) = self.load_thread(&params.thread_id).await?;
        Ok(Some(
            ChangeSetListResponse {
                change_sets: thread.list_change_sets().await,
            }
            .into(),
        ))
    }

    pub(crate) async fn change_set_hunk_locate(
        &self,
        params: ChangeSetHunkLocateParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        let (_, thread) = self.load_thread(&params.thread_id).await?;
        let response = thread
            .locate_change_set_hunk(
                &params.turn_id,
                &params.change_set_id,
                &params.file_id,
                &params.hunk_id,
            )
            .await
            .map_err(invalid_params)?;
        Ok(Some(response.into()))
    }

    pub(crate) async fn change_set_read(
        &self,
        params: ChangeSetReadParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        let (_, thread) = self.load_thread(&params.thread_id).await?;
        Ok(Some(
            ChangeSetReadResponse {
                change_set: thread.read_change_set(&params.turn_id).await,
            }
            .into(),
        ))
    }

    pub(crate) async fn change_set_review(
        &self,
        thread_id: &str,
        turn_id: &str,
        change_set_id: &str,
        selection: ReviewSelection<'_>,
        action: ReviewAction,
    ) -> Result<ChangeSetReviewResponse, JSONRPCErrorError> {
        let (thread_id, thread) = self.load_thread(thread_id).await?;
        let (change_set, results) = thread
            .review_change_set(turn_id, change_set_id, selection, action)
            .await
            .map_err(invalid_params)?;
        if results.iter().any(|result| result.changed) {
            let outgoing = ThreadScopedOutgoingMessageSender::new(
                Arc::clone(&self.outgoing),
                self.thread_state_manager
                    .subscribed_connection_ids(thread_id)
                    .await,
                thread_id,
            );
            outgoing
                .send_server_notification(ServerNotification::ChangeSetUpdated(
                    ChangeSetUpdatedNotification {
                        change_set: change_set.clone(),
                        results: results.clone(),
                    },
                ))
                .await;
        }
        Ok(ChangeSetReviewResponse {
            change_set,
            results,
        })
    }
}
