use std::sync::Arc;

use codex_history::RolloutItem;

use super::Session;
use super::TurnContext;

#[cfg(test)]
#[path = "change_review_tests.rs"]
mod tests;

impl Session {
    /// Cancellation may stop the caller after this boundary. The small append
    /// finishes independently so summary and delivery cursor cannot diverge.
    #[expect(
        clippy::await_holding_invalid_type,
        reason = "history append, durable retry detection and delivery cursor commit must serialize across cancellation and concurrent callers; persistence does not reacquire SessionState"
    )]
    pub(crate) async fn sync_review_context(
        self: &Arc<Self>,
        turn_context: &Arc<TurnContext>,
    ) -> codex_protocol::error::Result<()> {
        let sess = Arc::clone(self);
        let turn = Arc::clone(turn_context);
        tokio::spawn(async move {
            loop {
                let mut state = sess.state.lock().await;
                if state.review_context.needs_flush {
                    sess.flush_rollout().await?;
                    state.review_context.needs_flush = false;
                }
                let retry = state.review_context.retry_summary.is_some();
                let Some(mut envelope) = state
                    .review_context
                    .retry_summary
                    .clone()
                    .or_else(|| state.review_context.prepare())
                else {
                    return Ok(());
                };
                envelope.item.set_turn_id_if_missing(&turn.sub_id);
                let already_appended = if retry {
                    // An append can fail after writing but before acknowledging it.
                    // Drain the recorder first; do not append on an unknown outcome.
                    sess.flush_rollout().await?;
                    if let Some(live_thread) = sess.live_thread() {
                        let history = live_thread.load_history(false).await.map_err(|error| {
                            codex_protocol::error::CodexErr::from(std::io::Error::other(error))
                        })?;
                        history.items.iter().any(|item| {
                            matches!(item,
                        RolloutItem::ResponseItem(saved) if saved.item.id() == envelope.item.id())
                        })
                    } else {
                        false
                    }
                } else {
                    false
                };
                if retry && !already_appended {
                    // The old record is proven absent after the flush/read barrier.
                    // Include any review operations admitted after the failed attempt.
                    if let Some(current) = state.review_context.prepare() {
                        envelope = current;
                        envelope.item.set_turn_id_if_missing(&turn.sub_id);
                    }
                }
                let ids = envelope
                    .metadata
                    .as_ref()
                    .ok_or_else(|| {
                        codex_protocol::error::CodexErr::from(std::io::Error::other(
                            "Review summary is missing its delivery cursor",
                        ))
                    })?
                    .change_review_event_ids
                    .clone();
                let mut batch = state
                    .review_context
                    .undurable
                    .values()
                    .cloned()
                    .map(RolloutItem::ChangeReview)
                    .collect::<Vec<_>>();
                // Summary and cursor share one rollout record, including across retries.
                batch.push(RolloutItem::ResponseItem(envelope.clone()));
                state.review_context.retry_summary = Some(envelope.clone());
                if !already_appended && !sess.persist_rollout_items(&batch).await {
                    return Err(codex_protocol::error::CodexErr::from(
                        std::io::Error::other("Cannot persist review context before sampling"),
                    ));
                }
                // Publish in memory without an await between history append and cursor commit.
                // A failed flush is retried by the store's next barrier, not by appending
                // another summary after this one has already been accepted by the store.
                state.history.record_annotated_items(
                    std::slice::from_mut(&mut envelope),
                    turn.model_info().truncation_policy.into(),
                );
                state.review_context.mark_injected(&ids);
                state.review_context.retry_summary = None;
                state.review_context.needs_flush = true;
                sess.flush_rollout().await?;
                state.review_context.needs_flush = false;
                // If an earlier summary had already been persisted, newer facts still
                // need to be included before this caller may start sampling.
            }
        })
        .await
        .map_err(|error| codex_protocol::error::CodexErr::from(std::io::Error::other(error)))?
    }
}
