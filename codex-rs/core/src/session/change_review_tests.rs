use crate::change_review_context::tests::event;
use codex_history::RolloutItem;
use codex_protocol::change_set::ChangeReviewState;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;

#[tokio::test]
async fn review_context_ambiguous_append_retry_finds_existing_record() {
    let (mut sess, turn) = crate::session::tests::make_session_and_context().await;
    let store = crate::session::tests::attach_in_memory_thread_store(&mut sess).await;
    let sess = std::sync::Arc::new(sess);
    let turn = std::sync::Arc::new(turn);
    let mut prepared = {
        let mut state = sess.state.lock().await;
        state
            .review_context
            .observe(event("ambiguous", ChangeReviewState::Reverted));
        state.review_context.prepare().unwrap()
    };
    prepared.item.set_turn_id_if_missing(&turn.sub_id);
    // Simulate an append that was durable but whose acknowledgement was lost.
    sess.live_thread()
        .unwrap()
        .append_items(&[RolloutItem::ResponseItem(prepared.clone())])
        .await
        .unwrap();
    sess.state.lock().await.review_context.retry_summary = Some(prepared);
    let appends = store.calls().await.append_items;
    sess.sync_review_context(&turn).await.unwrap();
    assert_eq!(
        store.calls().await.append_items,
        appends,
        "retry must not append a duplicate durable summary"
    );
    assert_eq!(sess.clone_history().await.into_annotated_items().len(), 1);
    sess.sync_review_context(&turn).await.unwrap();
    assert_eq!(sess.clone_history().await.into_annotated_items().len(), 1);
}

#[tokio::test]
async fn review_context_retry_includes_operations_after_failed_attempt() {
    for already_saved in [false, true] {
        let (mut sess, turn) = crate::session::tests::make_session_and_context().await;
        crate::session::tests::attach_in_memory_thread_store(&mut sess).await;
        let sess = std::sync::Arc::new(sess);
        let turn = std::sync::Arc::new(turn);
        let mut frozen = {
            let mut state = sess.state.lock().await;
            state
                .review_context
                .observe(event("first", ChangeReviewState::Reverted));
            state.review_context.prepare().unwrap()
        };
        frozen.item.set_turn_id_if_missing(&turn.sub_id);
        if already_saved {
            sess.live_thread()
                .unwrap()
                .append_items(&[RolloutItem::ResponseItem(frozen.clone())])
                .await
                .unwrap();
        }
        {
            let mut state = sess.state.lock().await;
            state.review_context.retry_summary = Some(frozen);
            state
                .review_context
                .observe(event("second", ChangeReviewState::Reverted));
        }
        sess.sync_review_context(&turn).await.unwrap();
        assert!(sess.state.lock().await.review_context.prepare().is_none());
        let history = sess.clone_history().await.into_annotated_items();
        assert_eq!(history.len(), if already_saved { 2 } else { 1 });
        let delivered = history
            .iter()
            .flat_map(|item| &item.metadata.as_ref().unwrap().change_review_event_ids)
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            delivered,
            std::collections::BTreeSet::from(["first".to_owned(), "second".to_owned()])
        );
    }
}

#[tokio::test]
async fn review_context_history_tail_concurrent_retry_and_compaction() {
    let (sess, turn) = crate::session::tests::make_session_and_context().await;
    let sess = std::sync::Arc::new(sess);
    let turn = std::sync::Arc::new(turn);
    let old = ResponseItem::Message {
        id: None,
        role: "assistant".to_owned(),
        content: vec![ContentItem::OutputText {
            text: "Added abc".to_owned(),
        }],
        phase: None,
        internal_chat_message_metadata_passthrough: None,
    };
    sess.record_conversation_items(&turn, turn.model_info(), &[old])
        .await;
    let prefix = sess.clone_history().await.into_annotated_items();
    sess.state
        .lock()
        .await
        .review_context
        .observe(event("e", ChangeReviewState::Reverted));
    let (a, b) = tokio::join!(
        sess.sync_review_context(&turn),
        sess.sync_review_context(&turn)
    );
    a.unwrap();
    b.unwrap();
    let history = sess.clone_history().await.into_annotated_items();
    assert_eq!(&history[..prefix.len()], prefix.as_slice());
    assert_eq!(history.len(), prefix.len() + 1);
    let input = sess
        .clone_history()
        .await
        .for_prompt(&turn.model_info().input_modalities);
    assert!(format!("{input:?}").contains("change_review_facts"));
    // Simulate removal of the fact during normal compaction; no journal replay.
    sess.state.lock().await.history.replace_annotated(prefix);
    sess.sync_review_context(&turn).await.unwrap();
    assert_eq!(sess.clone_history().await.into_annotated_items().len(), 1);
}

#[tokio::test]
#[expect(
    clippy::await_holding_invalid_type,
    reason = "the test intentionally holds SessionState to stop the independent append task at a deterministic cancellation boundary"
)]
async fn review_context_cancelled_caller_does_not_split_history_and_cursor() {
    let (sess, turn) = crate::session::tests::make_session_and_context().await;
    let sess = std::sync::Arc::new(sess);
    let turn = std::sync::Arc::new(turn);
    let mut state = sess.state.lock().await;
    state
        .review_context
        .observe(event("cancel", ChangeReviewState::Reverted));
    let caller = tokio::spawn({
        let sess = std::sync::Arc::clone(&sess);
        let turn = std::sync::Arc::clone(&turn);
        async move { sess.sync_review_context(&turn).await }
    });
    // Allow the independent append task to start and block on the state lock.
    tokio::task::yield_now().await;
    caller.abort();
    drop(state);
    // Whether cancellation won before preparation or after it, retry adds once.
    sess.sync_review_context(&turn).await.unwrap();
    tokio::task::yield_now().await;
    assert_eq!(sess.clone_history().await.into_annotated_items().len(), 1);
    assert!(sess.state.lock().await.review_context.prepare().is_none());
}
