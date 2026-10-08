use super::*;
use crate::turn_diff_tracker::TurnDiffTracker;
use codex_exec_server::LOCAL_FS;
use std::fs;
use tempfile::TempDir;

async fn patch(dir: &TempDir, tracker: &mut TurnDiffTracker, body: &str) {
    let cwd = PathUri::from_host_native_path(dir.path()).unwrap();
    let delta = codex_apply_patch::apply_patch(
        body,
        &cwd,
        &mut Vec::new(),
        &mut Vec::new(),
        LOCAL_FS.as_ref(),
        None,
    )
    .await
    .unwrap();
    tracker.track_delta("local", &delta);
}

fn finalize(tracker: &TurnDiffTracker) -> ChangeSetReview {
    ChangeSetReview::from_tracked("thread", "turn", tracker.review_files())
}

async fn decide(
    review: &mut ChangeSetReview,
    hi: usize,
    action: ReviewAction,
) -> ChangeSetHunkResult {
    let file_id = review.snapshot.files[0].id.clone();
    let hunk_id = review.snapshot.files[0].hunks[hi].id.clone();
    review
        .review(
            ReviewSelection::Hunk {
                file_id: &file_id,
                hunk_id: &hunk_id,
            },
            action,
            LOCAL_FS.as_ref(),
        )
        .await
        .unwrap()
        .remove(0)
}

async fn modified(before: &str, after: &str) -> (TempDir, ChangeSetReview) {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let path = dir.path().join("a.txt");
    fs::write(&path, before).unwrap();
    let mut tracker = TurnDiffTracker::new();
    // AddFile deliberately overwrites an existing file: the engine captures its
    // actual dirty content, and the normalized file is Modified, not Added.
    let added = after
        .lines()
        .map(|line| format!("+{line}\n"))
        .collect::<String>();
    patch(
        &dir,
        &mut tracker,
        &format!("*** Begin Patch\n*** Add File: a.txt\n{added}*** End Patch"),
    )
    .await;
    (dir, finalize(&tracker))
}

#[tokio::test]
async fn two_hunks_revert_only_selected() {
    let (dir, mut review) = modified("A\nB\nC\nD\n", "A\nB2\nC\nD\nE\n").await;
    assert_eq!(review.snapshot.files[0].hunks.len(), 2);
    let ids = review.snapshot.files[0]
        .hunks
        .iter()
        .map(|h| h.id.clone())
        .collect::<Vec<_>>();
    let result = decide(&mut review, 0, ReviewAction::Revert).await;
    assert_eq!(result.state, ChangeReviewState::Reverted, "{result:?}");
    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "A\nB\nC\nD\nE\n"
    );
    assert_eq!(
        review.snapshot.files[0]
            .hunks
            .iter()
            .map(|h| h.id.clone())
            .collect::<Vec<_>>(),
        ids
    );
    assert_eq!(
        review.snapshot.files[0].hunks[1].state,
        ChangeReviewState::Pending
    );
}

#[tokio::test]
async fn review_context_records_actual_success_and_partial_file_failure() {
    let (dir, mut review) = modified(
        "A\nB\nC\nD\nE\nF\nG\nH\nI\nJ\n",
        "A\nB2\nC\nD\nE\nF\nG\nH\nI\nJ2\n",
    )
    .await;
    let path = dir.path().join("a.txt");
    // User changes the second target while the first remains safely matchable.
    fs::write(&path, "A\nB2\nC\nD\nE\nF\nG\nH\nI\nUSER\n").unwrap();
    let file_id = review.snapshot.files[0].id.clone();
    let results = review
        .review(
            ReviewSelection::File { file_id: &file_id },
            ReviewAction::Revert,
            LOCAL_FS.as_ref(),
        )
        .await
        .unwrap();
    assert_eq!(
        results.iter().map(|r| r.state).collect::<Vec<_>>(),
        vec![ChangeReviewState::Reverted, ChangeReviewState::Conflict]
    );
    let event = review
        .review_event("file", ReviewAction::Revert, &results)
        .unwrap();
    assert_eq!(event.revision, 1);
    assert_eq!(event.scope, "file");
    assert_eq!(event.outcomes[0].removed_text.as_deref(), Some("B2\n"));
    assert!(event.outcomes[1].removed_text.is_none());
    assert!(event.outcomes[1].reason.is_some());
    let repeated = review
        .review(
            ReviewSelection::All,
            ReviewAction::Revert,
            LOCAL_FS.as_ref(),
        )
        .await
        .unwrap();
    assert!(repeated.iter().all(|result| !result.changed));
    assert!(
        review
            .review_event("all", ReviewAction::Revert, &repeated)
            .is_none()
    );
    assert_eq!(
        fs::read_to_string(path).unwrap(),
        "A\nB\nC\nD\nE\nF\nG\nH\nI\nUSER\n"
    );
}

#[tokio::test]
async fn review_context_accept_and_io_conflict_are_not_success() {
    let (_dir, mut review) = modified("old\n", "abc\n").await;
    let accepted = decide(&mut review, 0, ReviewAction::Accept).await;
    assert!(
        review
            .review_event("hunk", ReviewAction::Accept, &[accepted])
            .is_none()
    );
    let (dir, mut review) = modified("old\n", "abc\n").await;
    fs::remove_file(dir.path().join("a.txt")).unwrap();
    fs::create_dir(dir.path().join("a.txt")).unwrap();
    let failed = decide(&mut review, 0, ReviewAction::Revert).await;
    assert_eq!(failed.state, ChangeReviewState::Conflict);
    let event = review
        .review_event("hunk", ReviewAction::Revert, &[failed])
        .unwrap();
    assert!(
        event
            .outcomes
            .iter()
            .all(|outcome| outcome.state != ChangeReviewState::Reverted)
    );
    let mut context = crate::change_review_context::ReviewContext::default();
    context.observe(event);
    assert!(context.prepare().is_none());
}

#[tokio::test]
async fn review_context_file_revert_records_precise_ranges_without_large_contents() {
    let (dir, mut review) = modified("A\nB\nC\nD\n", "A\nB2\nC\nD\nE\n").await;
    let results = review
        .review(
            ReviewSelection::All,
            ReviewAction::Revert,
            LOCAL_FS.as_ref(),
        )
        .await
        .unwrap();
    let event = review
        .review_event("all", ReviewAction::Revert, &results)
        .unwrap();
    assert_eq!(event.outcomes.len(), 2);
    assert!(
        event
            .outcomes
            .iter()
            .all(|outcome| outcome.state == ChangeReviewState::Reverted)
    );
    assert_eq!(event.outcomes[1].new_start, 5);
    assert_eq!(event.outcomes[1].new_lines, 1);
    assert_eq!(event.outcomes[1].old_lines, 0);
    fs::write(dir.path().join("a.txt"), "MANUAL AFTER REVIEW\n").unwrap();
    // Facts never read or overwrite the subsequent user edit.
    assert_eq!(
        review
            .review_event("all", ReviewAction::Revert, &results)
            .unwrap(),
        event
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "MANUAL AFTER REVIEW\n"
    );
    let (_dir, mut review) = modified("before\n", &format!("{}\n", "x".repeat(1024))).await;
    let result = decide(&mut review, 0, ReviewAction::Revert).await;
    assert!(
        review
            .review_event("hunk", ReviewAction::Revert, &[result])
            .unwrap()
            .outcomes[0]
            .removed_text
            .is_none()
    );
}

#[tokio::test]
async fn dirty_baseline_is_preserved() {
    let (dir, mut review) = modified("USER CHANGE\nA\nB\n", "USER CHANGE\nA2\nB\n").await;
    decide(&mut review, 0, ReviewAction::Revert).await;
    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "USER CHANGE\nA\nB\n"
    );
}

#[tokio::test]
async fn unrelated_user_edit_and_shift_are_preserved() {
    let before = (0..210).map(|i| format!("line {i}\n")).collect::<String>();
    let after = before.replace("line 10\n", "CODEX\n");
    let (dir, mut review) = modified(&before, &after).await;
    let user = format!(
        "USER INSERT\n{}",
        after.replace("line 200\n", "USER EDIT\n")
    );
    fs::write(dir.path().join("a.txt"), &user).unwrap();
    assert_eq!(
        decide(&mut review, 0, ReviewAction::Revert).await.state,
        ChangeReviewState::Reverted
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        user.replace("CODEX\n", "line 10\n")
    );
}

#[tokio::test]
async fn same_region_edit_conflicts_without_writing() {
    let (dir, mut review) = modified("A\nB\nC\n", "A\nB2\nC\n").await;
    let user = "A\nUSER\nC\n";
    fs::write(dir.path().join("a.txt"), user).unwrap();
    let result = decide(&mut review, 0, ReviewAction::Revert).await;
    assert_eq!(result.state, ChangeReviewState::Conflict);
    assert!(result.message.is_some());
    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), user);
}

#[tokio::test]
async fn new_file_reverts_only_when_unchanged() {
    for user_edit in [false, true] {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let mut tracker = TurnDiffTracker::new();
        patch(
            &dir,
            &mut tracker,
            "*** Begin Patch\n*** Add File: a.txt\n+CODEX\n*** End Patch",
        )
        .await;
        let mut review = finalize(&tracker);
        assert_eq!(
            review.snapshot.files[0].change_type,
            ChangeSetFileKind::Added
        );
        assert_eq!(review.snapshot.files[0].before_hash, None);
        if user_edit {
            fs::write(dir.path().join("a.txt"), "USER\n").unwrap();
        }
        let result = decide(&mut review, 0, ReviewAction::Revert).await;
        if user_edit {
            assert_eq!(result.state, ChangeReviewState::Conflict);
            assert_eq!(
                fs::read_to_string(dir.path().join("a.txt")).unwrap(),
                "USER\n"
            );
        } else {
            assert_eq!(result.state, ChangeReviewState::Reverted);
            assert!(!dir.path().join("a.txt").exists());
        }
    }
}

#[tokio::test]
async fn deleted_file_restores_baseline_or_conflicts_if_recreated() {
    for recreated in [false, true] {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        fs::write(dir.path().join("a.txt"), "DIRTY BASELINE\n").unwrap();
        let mut tracker = TurnDiffTracker::new();
        patch(
            &dir,
            &mut tracker,
            "*** Begin Patch\n*** Delete File: a.txt\n*** End Patch",
        )
        .await;
        let mut review = finalize(&tracker);
        assert_eq!(
            review.snapshot.files[0].change_type,
            ChangeSetFileKind::Deleted
        );
        if recreated {
            fs::write(dir.path().join("a.txt"), "USER\n").unwrap();
        }
        let result = decide(&mut review, 0, ReviewAction::Revert).await;
        assert_eq!(
            result.state,
            if recreated {
                ChangeReviewState::Conflict
            } else {
                ChangeReviewState::Reverted
            }
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            if recreated {
                "USER\n"
            } else {
                "DIRTY BASELINE\n"
            }
        );
    }
}

#[tokio::test]
async fn mixed_bulk_result_preserves_accepted_and_conflict() {
    let before = (0..30).map(|i| format!("line {i}\n")).collect::<String>();
    let after = before
        .replace("line 2\n", "A\n")
        .replace("line 12\n", "B\n")
        .replace("line 22\n", "C\n");
    let (dir, mut review) = modified(&before, &after).await;
    assert_eq!(review.snapshot.files[0].hunks.len(), 3);
    assert_eq!(
        decide(&mut review, 0, ReviewAction::Accept).await.state,
        ChangeReviewState::Accepted
    );
    fs::write(dir.path().join("a.txt"), after.replace("C\n", "USER\n")).unwrap();
    assert_eq!(
        decide(&mut review, 2, ReviewAction::Revert).await.state,
        ChangeReviewState::Conflict
    );
    let results = review
        .review(
            ReviewSelection::All,
            ReviewAction::Revert,
            LOCAL_FS.as_ref(),
        )
        .await
        .unwrap();
    assert_eq!(
        results.iter().map(|r| r.state).collect::<Vec<_>>(),
        [
            ChangeReviewState::Accepted,
            ChangeReviewState::Reverted,
            ChangeReviewState::Conflict
        ]
    );
    assert_eq!(
        results.iter().map(|r| r.changed).collect::<Vec<_>>(),
        [false, true, false]
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        after.replace("B\n", "line 12\n").replace("C\n", "USER\n")
    );
}

#[tokio::test]
async fn accept_file_and_all_are_metadata_only_and_terminal() {
    let (dir, mut review) = modified("A\nB\nC\nD\n", "A\nB2\nC\nD\nE\n").await;
    let file_id = review.snapshot.files[0].id.clone();
    review
        .review(
            ReviewSelection::File { file_id: &file_id },
            ReviewAction::Accept,
            LOCAL_FS.as_ref(),
        )
        .await
        .unwrap();
    assert_eq!(review.snapshot.state, ChangeReviewState::Accepted);
    assert!(!decide(&mut review, 0, ReviewAction::Revert).await.changed);
    review
        .review(
            ReviewSelection::All,
            ReviewAction::Accept,
            LOCAL_FS.as_ref(),
        )
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "A\nB2\nC\nD\nE\n"
    );
}

#[tokio::test]
async fn file_revert_keeps_accepted_hunks() {
    let (dir, mut review) = modified("A\nB\nC\nD\n", "A\nB2\nC\nD\nE\n").await;
    decide(&mut review, 0, ReviewAction::Accept).await;
    let file_id = review.snapshot.files[0].id.clone();
    let results = review
        .review(
            ReviewSelection::File { file_id: &file_id },
            ReviewAction::Revert,
            LOCAL_FS.as_ref(),
        )
        .await
        .unwrap();
    assert_eq!(
        results.iter().map(|r| r.state).collect::<Vec<_>>(),
        [ChangeReviewState::Accepted, ChangeReviewState::Reverted]
    );
    assert_eq!(review.snapshot.state, ChangeReviewState::Reviewed);
    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "A\nB2\nC\nD\n"
    );
}

#[tokio::test]
async fn first_absent_baseline_survives_add_delete_add() {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut tracker = TurnDiffTracker::new();
    for body in [
        "*** Add File: a.txt\n+one\n",
        "*** Delete File: a.txt\n",
        "*** Add File: a.txt\n+two\n",
    ] {
        patch(
            &dir,
            &mut tracker,
            &format!("*** Begin Patch\n{body}*** End Patch"),
        )
        .await;
    }
    let mut review = finalize(&tracker);
    assert_eq!(review.snapshot.files[0].before_content, None);
    assert_eq!(
        review.snapshot.files[0].change_type,
        ChangeSetFileKind::Added
    );
    decide(&mut review, 0, ReviewAction::Revert).await;
    assert!(!dir.path().join("a.txt").exists());
}

#[tokio::test]
async fn net_result_multiple_mutations_multiple_files_and_stable_ids() {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut tracker = TurnDiffTracker::new();
    fs::write(dir.path().join("a.txt"), "BASE\n").unwrap();
    for body in [
        "*** Update File: a.txt\n@@\n-BASE\n+MID\n",
        "*** Update File: a.txt\n@@\n-MID\n+FINAL\n",
        "*** Add File: b.txt\n+NEW\n",
    ] {
        patch(
            &dir,
            &mut tracker,
            &format!("*** Begin Patch\n{body}*** End Patch"),
        )
        .await;
    }
    let mut review = finalize(&tracker);
    assert_eq!(review.snapshot.files.len(), 2);
    assert_eq!(
        review.snapshot.files[0].before_content.as_deref(),
        Some("BASE\n")
    );
    assert_eq!(
        review.snapshot.files[0].after_content.as_deref(),
        Some("FINAL\n")
    );
    assert_eq!(review.snapshot, finalize(&tracker).snapshot);
    let other = ChangeSetReview::from_tracked("other-thread", "turn", tracker.review_files());
    assert_ne!(review.snapshot.id, other.snapshot.id);
    review
        .review(
            ReviewSelection::All,
            ReviewAction::Revert,
            LOCAL_FS.as_ref(),
        )
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "BASE\n"
    );
    assert!(!dir.path().join("b.txt").exists());
}

#[tokio::test]
async fn revert_order_handles_line_count_shifts() {
    let (dir, mut review) = modified("A\nB\nC\nD\n", "A\nB2\nEXTRA\nC\nD\nE\n").await;
    decide(&mut review, 0, ReviewAction::Revert).await;
    assert_eq!(
        decide(&mut review, 1, ReviewAction::Revert).await.state,
        ChangeReviewState::Reverted
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "A\nB\nC\nD\n"
    );
}

#[tokio::test]
async fn mixed_accept_revert_orders_preserve_line_changing_hunks() {
    let orders = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ];
    // Include empty ranges, expansion and contraction in every position.
    let shapes = [(0, 2), (2, 0), (1, 3), (3, 1)];
    let anchors = (0..4)
        .map(|block| {
            (0..8)
                .map(|line| format!("anchor {block}:{line}\n"))
                .collect::<String>()
        })
        .collect::<Vec<_>>();
    for pattern in 0..64 {
        let old = (0..3)
            .map(|index| {
                let count = shapes[(pattern >> (2 * index)) & 3].0;
                (0..count)
                    .map(|line| format!("old {index}:{line}\n"))
                    .collect::<String>()
            })
            .collect::<Vec<_>>();
        let new = (0..3)
            .map(|index| {
                let count = shapes[(pattern >> (2 * index)) & 3].1;
                (0..count)
                    .map(|line| format!("new {index}:{line}\n"))
                    .collect::<String>()
            })
            .collect::<Vec<_>>();
        let render = |reverted: &[bool; 3]| {
            let mut content = anchors[0].clone();
            for index in 0..3 {
                content.push_str(if reverted[index] {
                    &old[index]
                } else {
                    &new[index]
                });
                content.push_str(&anchors[index + 1]);
            }
            content
        };
        let before = render(&[true; 3]);
        let after = render(&[false; 3]);
        let (dir, template) = modified(&before, &after).await;
        let path = dir.path().join("a.txt");
        assert_eq!(template.snapshot.files[0].hunks.len(), 3);
        for accepted in 0..8 {
            for order in orders {
                fs::write(&path, &after).unwrap();
                let mut review = ChangeSetReview::from_tracked(
                    "thread",
                    "turn",
                    vec![TrackedFile {
                        environment_id: "local".to_string(),
                        path: PathUri::from_host_native_path(&path).unwrap(),
                        before: Some(before.clone()),
                        after: Some(after.clone()),
                        unsupported: None,
                    }],
                );
                let mut reverted = [false; 3];
                for index in order {
                    // Locate must report the exact range about to be reversed,
                    // across the full 3,072-scenario review-order matrix.
                    let prefix = (0..index).fold(anchors[0].clone(), |mut text, prior| {
                        text.push_str(if reverted[prior] {
                            &old[prior]
                        } else {
                            &new[prior]
                        });
                        text.push_str(&anchors[prior + 1]);
                        text
                    });
                    assert_eq!(
                        location(&review, index).await,
                        located(
                            lines(&prefix).len() as u32 + 1,
                            lines(&new[index]).len() as u32
                        ),
                    );
                    let accept = accepted & (1 << index) != 0;
                    let result = decide(
                        &mut review,
                        index,
                        if accept {
                            ReviewAction::Accept
                        } else {
                            ReviewAction::Revert
                        },
                    )
                    .await;
                    assert_eq!(
                        result.state,
                        if accept {
                            ChangeReviewState::Accepted
                        } else {
                            ChangeReviewState::Reverted
                        },
                        "pattern={pattern} accepted={accepted} order={order:?}: {result:?}"
                    );
                    reverted[index] = !accept;
                    assert_eq!(
                        fs::read_to_string(&path).unwrap(),
                        render(&reverted),
                        "pattern={pattern} accepted={accepted} order={order:?} step={index}"
                    );
                    for (actual, original) in review.snapshot.files[0]
                        .hunks
                        .iter()
                        .zip(&template.snapshot.files[0].hunks)
                    {
                        assert_eq!(actual.id, original.id);
                        assert_eq!(actual.patch, original.patch);
                        assert_eq!(actual.old_start, original.old_start);
                        assert_eq!(actual.new_start, original.new_start);
                        assert_eq!(actual.old_lines, original.old_lines);
                        assert_eq!(actual.new_lines, original.new_lines);
                    }
                }
                let terminal = review.snapshot.clone();
                let results = review
                    .review(
                        ReviewSelection::All,
                        ReviewAction::Revert,
                        LOCAL_FS.as_ref(),
                    )
                    .await
                    .unwrap();
                assert!(results.iter().all(|result| !result.changed));
                assert_eq!(review.snapshot, terminal);
                assert_eq!(fs::read_to_string(&path).unwrap(), render(&reverted));
            }
        }
    }
}

#[tokio::test]
async fn accepted_expansion_and_user_line_shifts_survive_file_and_all_revert() {
    let before = (0..80).map(|i| format!("line {i}\n")).collect::<String>();
    let after = before
        .replace("line 10\n", "A1\nA2\nA3\n")
        .replace("line 30\nline 31\nline 32\n", "B\n")
        .replace("line 60\n", "C1\nC2\n");
    for file in [false, true] {
        let (dir, mut review) = modified(&before, &after).await;
        let path = dir.path().join("a.txt");
        assert_eq!(review.snapshot.files[0].hunks.len(), 3);
        assert_eq!(
            decide(&mut review, 0, ReviewAction::Accept).await.state,
            ChangeReviewState::Accepted
        );
        let user = format!(
            "USER PREFIX 1\nUSER PREFIX 2\n{}",
            after.replace("line 50\nline 51\n", "USER MIDDLE\n")
        );
        fs::write(&path, &user).unwrap();
        // Reverting B increases the offset of C while the accepted A and the
        // user's independent insertions/deletions must remain untouched.
        assert_eq!(
            decide(&mut review, 1, ReviewAction::Revert).await.state,
            ChangeReviewState::Reverted
        );
        let file_id = review.snapshot.files[0].id.clone();
        let results = review
            .review(
                if file {
                    ReviewSelection::File { file_id: &file_id }
                } else {
                    ReviewSelection::All
                },
                ReviewAction::Revert,
                LOCAL_FS.as_ref(),
            )
            .await
            .unwrap();
        assert_eq!(
            results.iter().map(|r| r.state).collect::<Vec<_>>(),
            [
                ChangeReviewState::Accepted,
                ChangeReviewState::Reverted,
                ChangeReviewState::Reverted
            ]
        );
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            user.replace("B\n", "line 30\nline 31\nline 32\n")
                .replace("C1\nC2\n", "line 60\n")
        );
    }
}

#[tokio::test]
async fn line_shifts_preserve_accepted_and_conflicted_hunks() {
    let before = (0..80).map(|i| format!("line {i}\n")).collect::<String>();
    let after = before
        .replace("line 10\n", "A1\nA2\nA3\n")
        .replace("line 30\nline 31\nline 32\n", "B\n")
        .replace("line 60\n", "C1\nC2\n");
    let (dir, mut review) = modified(&before, &after).await;
    let path = dir.path().join("a.txt");
    decide(&mut review, 1, ReviewAction::Accept).await;
    let user = format!("USER PREFIX\n{}", after.replace("C1\nC2\n", "USER C\n"));
    fs::write(&path, &user).unwrap();
    assert_eq!(
        decide(&mut review, 2, ReviewAction::Revert).await.state,
        ChangeReviewState::Conflict
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), user);
    let results = review
        .review(
            ReviewSelection::All,
            ReviewAction::Revert,
            LOCAL_FS.as_ref(),
        )
        .await
        .unwrap();
    assert_eq!(
        results.iter().map(|r| r.state).collect::<Vec<_>>(),
        [
            ChangeReviewState::Reverted,
            ChangeReviewState::Accepted,
            ChangeReviewState::Conflict
        ]
    );
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        user.replace("A1\nA2\nA3\n", "line 10\n")
    );
}

#[tokio::test]
async fn interleaved_external_edits_are_not_attributed_to_codex() {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut tracker = TurnDiffTracker::new();
    patch(
        &dir,
        &mut tracker,
        "*** Begin Patch\n*** Add File: a.txt\n+CODEX\n*** End Patch",
    )
    .await;
    fs::write(dir.path().join("a.txt"), "USER\n").unwrap();
    patch(
        &dir,
        &mut tracker,
        "*** Begin Patch\n*** Update File: a.txt\n@@\n-USER\n+NEW\n*** End Patch",
    )
    .await;
    let review = finalize(&tracker);
    assert_eq!(
        review.snapshot.files[0].state,
        ChangeReviewState::Unsupported
    );
    assert!(review.snapshot.files[0].hunks.is_empty());
}

#[test]
fn ambiguous_or_changed_context_never_uses_fuzzy_matching() {
    assert!(
        locate(
            "x\nx\nx\nB\nx\nx\nx\n",
            "x\nx\nx\nB\nx\nx\nx\nx\nx\nx\nB\nx\nx\nx\n",
            3..4
        )
        .is_err()
    );
    assert!(locate("A\nC\n", "A\nUSER\nC\n", 1..1).is_err());
}

#[test]
fn unsupported_text_size_binary_and_presence_only() {
    for text in ["a\0b".to_string(), "x".repeat(MAX_REVIEW_FILE_BYTES + 1)] {
        let review = ChangeSetReview::from_tracked(
            "t",
            "u",
            vec![TrackedFile {
                environment_id: "local".into(),
                path: PathUri::from_host_native_path(std::path::Path::new("/tmp/a")).unwrap(),
                before: None,
                after: Some(text),
                unsupported: None,
            }],
        );
        assert_eq!(
            review.snapshot.files[0].state,
            ChangeReviewState::Unsupported
        );
        assert!(review.snapshot.files[0].after_content.is_none());
    }
    let review = ChangeSetReview::from_tracked(
        "t",
        "u",
        vec![TrackedFile {
            environment_id: "local".into(),
            path: PathUri::from_host_native_path(std::path::Path::new("/tmp/a")).unwrap(),
            before: None,
            after: Some(String::new()),
            unsupported: None,
        }],
    );
    assert_eq!(review.snapshot.files[0].hunks.len(), 1);
}

#[tokio::test]
async fn crlf_and_missing_final_newline_are_restored_exactly() {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let before = "A\r\nB";
    let after = "A\r\nB2";
    fs::write(dir.path().join("a.txt"), after).unwrap();
    let mut review = ChangeSetReview::from_tracked(
        "t",
        "u",
        vec![TrackedFile {
            environment_id: "local".into(),
            path: PathUri::from_host_native_path(&dir.path().join("a.txt")).unwrap(),
            before: Some(before.into()),
            after: Some(after.into()),
            unsupported: None,
        }],
    );
    assert!(
        review.snapshot.files[0].hunks[0]
            .patch
            .contains("No newline")
    );
    decide(&mut review, 0, ReviewAction::Revert).await;
    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        before
    );
}

#[cfg(unix)]
#[tokio::test]
async fn symlink_substitution_conflicts() {
    let (dir, mut review) = modified("A\n", "B\n").await;
    let path = dir.path().join("a.txt");
    let target = dir.path().join("user.txt");
    fs::write(&target, "B\n").unwrap();
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();
    assert_eq!(
        decide(&mut review, 0, ReviewAction::Revert).await.state,
        ChangeReviewState::Conflict
    );
    assert_eq!(fs::read_to_string(target).unwrap(), "B\n");
}

#[tokio::test]
async fn remote_and_rename_are_visible_but_not_reviewable() {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut tracker = TurnDiffTracker::new();
    fs::write(dir.path().join("a.txt"), "A\n").unwrap();
    patch(
        &dir,
        &mut tracker,
        "*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-A\n+B\n*** End Patch",
    )
    .await;
    let mut review = finalize(&tracker);
    assert_eq!(review.snapshot.files.len(), 2);
    assert!(
        review
            .snapshot
            .files
            .iter()
            .all(|f| f.state == ChangeReviewState::Unsupported)
    );
    assert!(
        review
            .review(
                ReviewSelection::All,
                ReviewAction::Revert,
                LOCAL_FS.as_ref()
            )
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(fs::read_to_string(dir.path().join("b.txt")).unwrap(), "B\n");
    let mut tracker = TurnDiffTracker::new();
    tracker.mark_review_environment_unsupported("local");
    patch(
        &dir,
        &mut tracker,
        "*** Begin Patch\n*** Add File: c.txt\n+C\n*** End Patch",
    )
    .await;
    assert_eq!(
        finalize(&tracker).snapshot.files[0].state,
        ChangeReviewState::Unsupported
    );
}

#[tokio::test]
async fn unknown_selection_does_not_write_or_change_revision() {
    let (dir, mut review) = modified("A\n", "B\n").await;
    let before = review.snapshot.clone();
    assert!(
        review
            .review(
                ReviewSelection::File { file_id: "unknown" },
                ReviewAction::Revert,
                LOCAL_FS.as_ref()
            )
            .await
            .is_err()
    );
    assert_eq!(review.snapshot, before);
    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "B\n");
}

#[test]
fn formerly_duplicated_context_cannot_target_a_different_copy() {
    let expected = "head\na\nb\nc\nCODEX\nx\ny\nz\nseparator\na\nb\nc\nCODEX\nx\ny\nz\ntail\n";
    let current = expected.replacen("CODEX", "USER", 1);
    assert!(locate(expected, &current, 4..5).is_err());
}

#[tokio::test]
async fn pending_revert_waits_for_tracked_patch_mutations() {
    let (dir, mut review) = modified("A\n", "B\n").await;
    let gate = REVIEW_MUTATION_GATE.read().await;
    let result = tokio::spawn(async move {
        let result = review
            .review(
                ReviewSelection::All,
                ReviewAction::Revert,
                LOCAL_FS.as_ref(),
            )
            .await
            .unwrap();
        (review, result)
    });
    tokio::task::yield_now().await;
    assert!(!result.is_finished());
    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "B\n");
    drop(gate);
    let (_, results) = result.await.unwrap();
    assert_eq!(results[0].state, ChangeReviewState::Reverted);
    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "A\n");
}

#[tokio::test]
async fn recovered_terminal_turn_cannot_invent_a_review_baseline() {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut tracker = TurnDiffTracker::new();
    tracker.disable_review("Review of a recovered finalized turn is not supported");
    patch(
        &dir,
        &mut tracker,
        "*** Begin Patch\n*** Add File: a.txt\n+RECOVERED\n*** End Patch",
    )
    .await;
    let mut review = finalize(&tracker);
    assert_eq!(
        review.snapshot.files[0].state,
        ChangeReviewState::Unsupported
    );
    assert!(
        review
            .review(
                ReviewSelection::All,
                ReviewAction::Revert,
                LOCAL_FS.as_ref()
            )
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "RECOVERED\n"
    );
}

async fn location(review: &ChangeSetReview, hi: usize) -> HunkLocationResult {
    let snapshot = review.snapshot.clone();
    let file = &snapshot.files[0];
    let response = review
        .locate_hunk(&file.id, &file.hunks[hi].id, LOCAL_FS.as_ref())
        .await
        .unwrap();
    assert_eq!(response.change_set_id, snapshot.id);
    assert_eq!(response.file_id, file.id);
    assert_eq!(response.hunk_id, file.hunks[hi].id);
    assert_eq!(response.path, file.path);
    assert_eq!(
        review.snapshot, snapshot,
        "locate must not mutate review metadata"
    );
    response.result
}

fn located(start_line: u32, line_count: u32) -> HunkLocationResult {
    HunkLocationResult::Located {
        start_line,
        line_count,
        kind: if line_count == 0 {
            CurrentHunkRangeKind::DeletionAnchor
        } else {
            CurrentHunkRangeKind::Content
        },
    }
}

#[tokio::test]
async fn locator_original_and_accepted_positions() {
    let (dir, mut review) = modified("A\nB\nC\n", "A\nB2\nC\n").await;
    assert_eq!(location(&review, 0).await, located(2, 1));
    decide(&mut review, 0, ReviewAction::Accept).await;
    assert_eq!(location(&review, 0).await, located(2, 1));
    fs::write(dir.path().join("a.txt"), "A\nUSER\nC\n").unwrap();
    assert!(matches!(
        location(&review, 0).await,
        HunkLocationResult::Conflict { .. }
    ));
    assert_eq!(
        review.snapshot.files[0].hunks[0].state,
        ChangeReviewState::Accepted
    );
}

#[tokio::test]
async fn locator_earlier_revert_negative_and_positive_offsets_and_accept() {
    let prefix = (0..10).map(|i| format!("prefix {i}\n")).collect::<String>();
    let gap = (0..10).map(|i| format!("gap {i}\n")).collect::<String>();
    let extra = (0..20).map(|i| format!("extra {i}\n")).collect::<String>();
    for deletion in [false, true] {
        for accept in [false, true] {
            let before = format!(
                "{prefix}{}{gap}old\ntail\n",
                if deletion { &extra } else { "" }
            );
            let after = format!(
                "{prefix}{}{gap}new\ntail\n",
                if deletion { "" } else { &extra }
            );
            let (_dir, mut review) = modified(&before, &after).await;
            assert_eq!(review.snapshot.files[0].hunks.len(), 2);
            let historical = review.snapshot.files[0].hunks[1].new_start;
            assert_eq!(location(&review, 1).await, located(historical, 1));
            decide(
                &mut review,
                0,
                if accept {
                    ReviewAction::Accept
                } else {
                    ReviewAction::Revert
                },
            )
            .await;
            let shift = if accept {
                0
            } else if deletion {
                20
            } else {
                -20
            };
            assert_eq!(
                location(&review, 1).await,
                located(historical.checked_add_signed(shift).unwrap(), 1)
            );
        }
    }
}

#[tokio::test]
async fn locator_user_insertion_deletion_before_and_edit_after_target() {
    let before = (0..150).map(|i| format!("line {i}\n")).collect::<String>();
    let after = before.replace("line 100\n", "CODEX\n");
    let (dir, mut review) = modified(&before, &after).await;
    let path = dir.path().join("a.txt");
    for (user, start) in [
        (format!("{}{after}", "USER\n".repeat(20)), 121),
        (lines(&after)[20..].concat(), 81),
        (after.replace("line 140\n", "USER AFTER\n"), 101),
    ] {
        fs::write(&path, &user).unwrap();
        assert_eq!(location(&review, 0).await, located(start, 1));
        assert_eq!(fs::read_to_string(&path).unwrap(), user);
    }
    // Verify the reported line is the range actually changed by revert.
    assert_eq!(
        decide(&mut review, 0, ReviewAction::Revert).await.state,
        ChangeReviewState::Reverted
    );
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        before.replace("line 140\n", "USER AFTER\n")
    );
}

#[tokio::test]
async fn locator_target_edit_and_conflict_retry_are_read_only() {
    let (dir, mut review) = modified("A\nB\nC\n", "A\nB2\nC\n").await;
    let path = dir.path().join("a.txt");
    fs::write(&path, "A\nUSER\nC\n").unwrap();
    assert!(matches!(
        location(&review, 0).await,
        HunkLocationResult::Conflict { .. }
    ));
    assert_eq!(
        review.snapshot.files[0].hunks[0].state,
        ChangeReviewState::Pending
    );
    assert_eq!(
        decide(&mut review, 0, ReviewAction::Revert).await.state,
        ChangeReviewState::Conflict
    );
    assert!(matches!(
        location(&review, 0).await,
        HunkLocationResult::Conflict { .. }
    ));
    fs::write(&path, "A\nB2\nC\n").unwrap();
    assert_eq!(location(&review, 0).await, located(2, 1));
    assert_eq!(
        review.snapshot.files[0].hunks[0].state,
        ChangeReviewState::Conflict
    );
}

#[tokio::test]
async fn locator_ambiguous_duplicates_follow_revert_matching() {
    let before = "p0\np1\np2\np3\nold\ns0\ns1\ns2\ns3\n";
    let after = before.replace("old\n", "CODEX\n");
    let (dir, mut review) = modified(before, &after).await;
    let user = format!("{after}{after}");
    fs::write(dir.path().join("a.txt"), &user).unwrap();
    assert!(matches!(
        location(&review, 0).await,
        HunkLocationResult::Conflict { .. }
    ));
    assert_eq!(
        decide(&mut review, 0, ReviewAction::Revert).await.state,
        ChangeReviewState::Conflict
    );
    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), user);
}

#[tokio::test]
async fn locator_reverted_hunk_is_not_present() {
    let (_dir, mut review) = modified("A\nB\nC\n", "A\nB2\nC\n").await;
    decide(&mut review, 0, ReviewAction::Revert).await;
    assert_eq!(
        location(&review, 0).await,
        HunkLocationResult::NotPresent {
            reason: HunkNotPresentReason::Reverted
        }
    );
}

#[tokio::test]
async fn locator_pure_insertion_and_shifted_deletion_anchor() {
    let prefix = (0..10).map(|i| format!("prefix {i}\n")).collect::<String>();
    let suffix = (0..10).map(|i| format!("suffix {i}\n")).collect::<String>();
    for deletion in [false, true] {
        let before = format!("{prefix}{}{suffix}", if deletion { "A\nB\n" } else { "" });
        let after = format!("{prefix}{}{suffix}", if deletion { "" } else { "A\nB\n" });
        let (dir, mut review) = modified(&before, &after).await;
        let count = if deletion { 0 } else { 2 };
        assert_eq!(location(&review, 0).await, located(11, count));
        fs::write(dir.path().join("a.txt"), format!("USER\n{after}")).unwrap();
        assert_eq!(location(&review, 0).await, located(12, count));
        assert_eq!(
            decide(&mut review, 0, ReviewAction::Revert).await.state,
            ChangeReviewState::Reverted
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            format!("USER\n{before}")
        );
    }
}

#[tokio::test]
async fn locator_deletion_anchors_at_bof_eof_and_empty_file() {
    for (before, after, anchor) in [
        ("A\nB\nC\n", "B\nC\n", 1),
        ("A\nB\nC\n", "A\nB\n", 3),
        ("A\nB\n", "", 1),
    ] {
        let (_dir, review) = modified(before, after).await;
        assert_eq!(location(&review, 0).await, located(anchor, 0));
    }
}

#[tokio::test]
async fn locator_added_deleted_and_presence_only_files() {
    for (before, after) in [
        (None, Some("CODEX\n")),
        (None, Some("")),
        (Some("OLD\n"), None),
        (Some(""), None),
    ] {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let path = dir.path().join("a.txt");
        if let Some(after) = after {
            fs::write(&path, after).unwrap();
        }
        let mut review = ChangeSetReview::from_tracked(
            "t",
            "u",
            vec![TrackedFile {
                environment_id: "local".into(),
                path: PathUri::from_host_native_path(&path).unwrap(),
                before: before.map(str::to_owned),
                after: after.map(str::to_owned),
                unsupported: None,
            }],
        );
        if let Some(after) = after {
            let count = lines(after).len() as u32;
            let mut expected = located(1, count);
            if count == 0 {
                expected = HunkLocationResult::Located {
                    start_line: 1,
                    line_count: 0,
                    kind: CurrentHunkRangeKind::FilePresence,
                };
            }
            assert_eq!(location(&review, 0).await, expected);
            fs::write(&path, "USER\n").unwrap();
            assert!(matches!(
                location(&review, 0).await,
                HunkLocationResult::Conflict { .. }
            ));
            fs::remove_file(&path).unwrap();
            assert_eq!(
                location(&review, 0).await,
                HunkLocationResult::NotPresent {
                    reason: HunkNotPresentReason::FileMissing
                }
            );
            fs::write(&path, after).unwrap();
        } else {
            assert_eq!(
                location(&review, 0).await,
                HunkLocationResult::NotPresent {
                    reason: HunkNotPresentReason::FileDeleted
                }
            );
            fs::write(&path, "RECREATED\n").unwrap();
            assert!(matches!(
                location(&review, 0).await,
                HunkLocationResult::Conflict { .. }
            ));
            fs::remove_file(&path).unwrap();
        }
        assert_eq!(
            decide(&mut review, 0, ReviewAction::Revert).await.state,
            ChangeReviewState::Reverted
        );
        assert_eq!(
            location(&review, 0).await,
            HunkLocationResult::NotPresent {
                reason: HunkNotPresentReason::Reverted
            }
        );
    }
}

#[tokio::test]
async fn locator_unsupported_current_files_and_missing_modified_file() {
    let (dir, review) = modified("A\n", "B\n").await;
    let path = dir.path().join("a.txt");
    for content in [
        b"binary\0".to_vec(),
        vec![0xff],
        vec![b'x'; MAX_REVIEW_FILE_BYTES + 1],
    ] {
        fs::write(&path, content).unwrap();
        assert!(matches!(
            location(&review, 0).await,
            HunkLocationResult::Unsupported { .. }
        ));
    }
    fs::remove_file(&path).unwrap();
    assert_eq!(
        location(&review, 0).await,
        HunkLocationResult::NotPresent {
            reason: HunkNotPresentReason::FileMissing
        }
    );
    fs::create_dir(&path).unwrap();
    assert!(matches!(
        location(&review, 0).await,
        HunkLocationResult::Unsupported { .. }
    ));
}

#[tokio::test]
async fn locator_unsupported_snapshot_and_unknown_ids() {
    let (_dir, mut review) = modified("A\n", "B\n").await;
    let file = &review.snapshot.files[0];
    assert!(
        review
            .locate_hunk("unknown", &file.hunks[0].id, LOCAL_FS.as_ref())
            .await
            .is_err()
    );
    assert!(
        review
            .locate_hunk(&file.id, "unknown", LOCAL_FS.as_ref())
            .await
            .is_err()
    );
    review.snapshot.files[0].unsupported_reason = Some("Rename is unsupported".into());
    assert!(matches!(
        location(&review, 0).await,
        HunkLocationResult::Unsupported { .. }
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn locator_symlink_is_unsupported_without_touching_target() {
    let (dir, review) = modified("A\n", "B\n").await;
    let path = dir.path().join("a.txt");
    let target = dir.path().join("user.txt");
    fs::write(&target, "USER\n").unwrap();
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();
    assert!(matches!(
        location(&review, 0).await,
        HunkLocationResult::Unsupported { .. }
    ));
    assert!(fs::symlink_metadata(&path).unwrap().is_symlink());
    assert_eq!(fs::read_to_string(&target).unwrap(), "USER\n");
}

#[tokio::test]
async fn locator_unsupported_files_without_hunk_metadata() {
    let review = ChangeSetReview::from_tracked(
        "t",
        "u",
        vec![TrackedFile {
            environment_id: "local".into(),
            path: PathUri::from_host_native_path(std::path::Path::new("/tmp/unread-locator-file"))
                .unwrap(),
            before: Some("baseline".into()),
            after: Some("renamed".into()),
            unsupported: Some("Rename is unsupported".into()),
        }],
    );
    let snapshot = review.snapshot.clone();
    assert!(snapshot.files[0].hunks.is_empty());
    let result = review
        .locate_hunk(&snapshot.files[0].id, "", LOCAL_FS.as_ref())
        .await
        .unwrap();
    assert_eq!(
        result.result,
        HunkLocationResult::Unsupported {
            reason: "Rename is unsupported".into()
        }
    );
    assert_eq!(review.snapshot, snapshot);
}
