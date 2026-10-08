use anyhow::Result;
use app_test_support::MockResponsesConfig;
use app_test_support::TestAppServer;
use app_test_support::create_apply_patch_sse_response;
use app_test_support::create_final_assistant_message_sse_response;
use app_test_support::create_mock_responses_server_sequence_unchecked;
use codex_app_server_protocol::ChangeReviewState;
use codex_app_server_protocol::ChangeSet;
use codex_app_server_protocol::ChangeSetCreatedNotification;
use codex_app_server_protocol::ChangeSetFileReviewParams;
use codex_app_server_protocol::ChangeSetHunkLocateParams;
use codex_app_server_protocol::ChangeSetHunkLocateResponse;
use codex_app_server_protocol::ChangeSetHunkReviewParams;
use codex_app_server_protocol::ChangeSetListParams;
use codex_app_server_protocol::ChangeSetListResponse;
use codex_app_server_protocol::ChangeSetReadParams;
use codex_app_server_protocol::ChangeSetReadResponse;
use codex_app_server_protocol::ChangeSetReviewParams;
use codex_app_server_protocol::ChangeSetReviewResponse;
use codex_app_server_protocol::ChangeSetUpdatedNotification;
use codex_app_server_protocol::ClientRequest;
use codex_app_server_protocol::CurrentHunkRangeKind;
use codex_app_server_protocol::HunkLocationResult;
use codex_app_server_protocol::HunkNotPresentReason;
use codex_app_server_protocol::ThreadCompactStartParams;
use codex_app_server_protocol::ThreadCompactStartResponse;
use codex_app_server_protocol::ThreadResumeParams;
use codex_app_server_protocol::ThreadResumeResponse;
use codex_app_server_protocol::ThreadStartParams;
use codex_app_server_protocol::ThreadStartResponse;
use codex_app_server_protocol::TurnCompletedNotification;
use codex_app_server_protocol::TurnStartParams;
use codex_app_server_protocol::TurnStartResponse;
use codex_app_server_protocol::UserInput;
use codex_features::Feature;
use core_test_support::skip_if_no_network;
use core_test_support::skip_if_remote;
use std::fs;
use std::path::PathBuf;
use tempfile::TempDir;
use wiremock::MockServer;

struct Fixture {
    mcp: TestAppServer,
    set: ChangeSet,
    path: PathBuf,
    _dir: TempDir,
    _server: MockServer,
    home: PathBuf,
}

async fn setup(before: Option<&str>, after: Option<&str>) -> Result<Fixture> {
    setup_with_followups(before, after, 0).await
}

async fn setup_with_followups(
    before: Option<&str>,
    after: Option<&str>,
    followups: usize,
) -> Result<Fixture> {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize()?)?;
    let home = dir.path().join("home");
    let workspace = dir.path().join("workspace");
    fs::create_dir(&home)?;
    fs::create_dir(&workspace)?;
    let path = workspace.join("a.txt");
    if let Some(before) = before {
        fs::write(&path, before)?;
    }
    let body = match after {
        Some(after) => format!(
            "*** Add File: a.txt\n{}",
            after
                .lines()
                .map(|line| format!("+{line}\n"))
                .collect::<String>()
        ),
        None => "*** Delete File: a.txt\n".to_string(),
    };
    let patch = format!("*** Begin Patch\n{body}*** End Patch\n");
    let mut responses = vec![
        create_apply_patch_sse_response(&patch, "patch-call")?,
        create_final_assistant_message_sse_response("done")?,
    ];
    for _ in 0..followups {
        responses.push(create_final_assistant_message_sse_response("followup")?);
    }
    let server = create_mock_responses_server_sequence_unchecked(responses).await;
    MockResponsesConfig::new(&server.uri())
        .with_approval_policy("never")
        .with_sandbox_mode("danger-full-access")
        .disable_feature(Feature::ShellSnapshot)
        .write(&home)?;
    let mut mcp = TestAppServer::builder()
        .with_codex_home(&home)
        .build_initialized()
        .await?;
    let ThreadStartResponse { thread, .. } = mcp
        .start_thread(ThreadStartParams {
            model: Some("mock-model".into()),
            cwd: Some(workspace.to_string_lossy().into_owned()),
            ..Default::default()
        })
        .await?;
    let TurnStartResponse { turn } = mcp
        .request(|request_id| ClientRequest::TurnStart {
            request_id,
            params: TurnStartParams {
                thread_id: thread.id.clone(),
                input: vec![UserInput::Text {
                    text: "apply patch".into(),
                    text_elements: Vec::new(),
                }],
                cwd: Some(workspace),
                ..Default::default()
            },
        })
        .await?;
    let created: ChangeSetCreatedNotification = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        mcp.read_notification("changeSet/created"),
    )
    .await??;
    let completed: TurnCompletedNotification = mcp.read_notification("turn/completed").await?;
    assert_eq!(completed.turn.id, turn.id);
    assert_eq!(created.change_set.thread_id, thread.id);
    assert_eq!(created.change_set.turn_id, turn.id);
    let read: ChangeSetReadResponse = mcp
        .request(|request_id| ClientRequest::ChangeSetRead {
            request_id,
            params: ChangeSetReadParams {
                thread_id: thread.id,
                turn_id: turn.id,
            },
        })
        .await?;
    let set = read.change_set.expect("finalized set retained in Core");
    assert_eq!(set, created.change_set);
    assert_eq!(set.coverage, "applyPatchOnly");
    let listed: ChangeSetListResponse = mcp
        .request(|request_id| ClientRequest::ChangeSetList {
            request_id,
            params: ChangeSetListParams {
                thread_id: set.thread_id.clone(),
            },
        })
        .await?;
    assert_eq!(listed.change_sets, vec![set.clone()]);
    Ok(Fixture {
        mcp,
        set,
        path,
        _dir: dir,
        _server: server,
        home,
    })
}

impl Fixture {
    async fn followup(&mut self) -> Result<serde_json::Value> {
        let _: TurnStartResponse = self
            .mcp
            .request(|request_id| ClientRequest::TurnStart {
                request_id,
                params: TurnStartParams {
                    thread_id: self.set.thread_id.clone(),
                    input: vec![UserInput::Text {
                        text: "What edits did I undo through review?".to_owned(),
                        text_elements: vec![],
                    }],
                    ..Default::default()
                },
            })
            .await?;
        let _: TurnCompletedNotification = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            self.mcp.read_notification("turn/completed"),
        )
        .await??;
        let requests = self._server.received_requests().await.unwrap();
        Ok(serde_json::from_slice(&requests.last().unwrap().body)?)
    }

    async fn cold_resume(&mut self) -> Result<()> {
        self.mcp.shutdown_gracefully().await?;
        self.mcp = TestAppServer::builder()
            .with_codex_home(&self.home)
            .build_initialized()
            .await?;
        let _: ThreadResumeResponse = self
            .mcp
            .request(|request_id| ClientRequest::ThreadResume {
                request_id,
                params: ThreadResumeParams {
                    thread_id: self.set.thread_id.clone(),
                    ..Default::default()
                },
            })
            .await?;
        let listed: ChangeSetListResponse = self
            .mcp
            .request(|request_id| ClientRequest::ChangeSetList {
                request_id,
                params: ChangeSetListParams {
                    thread_id: self.set.thread_id.clone(),
                },
            })
            .await?;
        assert!(
            listed.change_sets.is_empty(),
            "review facts persist without restoring ChangeSet/baselines"
        );
        Ok(())
    }

    async fn locate(&mut self, index: usize) -> Result<HunkLocationResult> {
        let file = &self.set.files[0];
        let params = ChangeSetHunkLocateParams {
            thread_id: self.set.thread_id.clone(),
            turn_id: self.set.turn_id.clone(),
            change_set_id: self.set.id.clone(),
            file_id: file.id.clone(),
            hunk_id: file.hunks[index].id.clone(),
        };
        let response: ChangeSetHunkLocateResponse = self
            .mcp
            .request(|request_id| ClientRequest::ChangeSetHunkLocate { request_id, params })
            .await?;
        assert_eq!(response.change_set_id, self.set.id);
        assert_eq!(response.file_id, file.id);
        assert_eq!(response.hunk_id, file.hunks[index].id);
        assert_eq!(response.path, file.path);
        let read: ChangeSetReadResponse = self
            .mcp
            .request(|request_id| ClientRequest::ChangeSetRead {
                request_id,
                params: ChangeSetReadParams {
                    thread_id: self.set.thread_id.clone(),
                    turn_id: self.set.turn_id.clone(),
                },
            })
            .await?;
        assert_eq!(
            read.change_set.as_ref(),
            Some(&self.set),
            "locate cannot change decisions or revision"
        );
        assert!(
            !self
                .mcp
                .pending_notification_methods()
                .iter()
                .any(|method| method == "changeSet/updated"),
            "locate cannot emit review notifications"
        );
        Ok(response.result)
    }

    async fn hunk(&mut self, index: usize, accept: bool) -> Result<ChangeSetReviewResponse> {
        let params = ChangeSetHunkReviewParams {
            thread_id: self.set.thread_id.clone(),
            turn_id: self.set.turn_id.clone(),
            change_set_id: self.set.id.clone(),
            file_id: self.set.files[0].id.clone(),
            hunk_id: self.set.files[0].hunks[index].id.clone(),
        };
        let response: ChangeSetReviewResponse = self
            .mcp
            .request(|request_id| {
                if accept {
                    ClientRequest::ChangeSetHunkAccept { request_id, params }
                } else {
                    ClientRequest::ChangeSetHunkRevert { request_id, params }
                }
            })
            .await?;
        self.verify_update(&response).await?;
        Ok(response)
    }

    async fn all(&mut self, accept: bool, file: bool) -> Result<ChangeSetReviewResponse> {
        let params = ChangeSetReviewParams {
            thread_id: self.set.thread_id.clone(),
            turn_id: self.set.turn_id.clone(),
            change_set_id: self.set.id.clone(),
        };
        let file_params = ChangeSetFileReviewParams {
            thread_id: params.thread_id.clone(),
            turn_id: params.turn_id.clone(),
            change_set_id: params.change_set_id.clone(),
            file_id: self.set.files[0].id.clone(),
        };
        let response: ChangeSetReviewResponse = self
            .mcp
            .request(|request_id| match (accept, file) {
                (true, true) => ClientRequest::ChangeSetFileAccept {
                    request_id,
                    params: file_params,
                },
                (false, true) => ClientRequest::ChangeSetFileRevert {
                    request_id,
                    params: file_params,
                },
                (true, false) => ClientRequest::ChangeSetAccept { request_id, params },
                (false, false) => ClientRequest::ChangeSetRevert { request_id, params },
            })
            .await?;
        self.verify_update(&response).await?;
        Ok(response)
    }

    async fn verify_update(&mut self, response: &ChangeSetReviewResponse) -> Result<()> {
        if response.results.iter().any(|r| r.changed) {
            let updated: ChangeSetUpdatedNotification =
                self.mcp.read_notification("changeSet/updated").await?;
            assert_eq!(updated.change_set, response.change_set);
            assert_eq!(updated.results, response.results);
            assert!(updated.change_set.revision > self.set.revision);
        }
        self.set = response.change_set.clone();
        Ok(())
    }
}

fn review_facts(body: &serde_json::Value) -> Vec<String> {
    body["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["role"] == "developer")
        .flat_map(|item| item["content"].as_array().unwrap())
        .filter_map(|part| part["text"].as_str())
        .filter(|text| text.contains("<change_review_facts>"))
        .map(str::to_owned)
        .collect()
}

#[tokio::test]
async fn review_context_next_model_input_has_one_merged_fact_and_unchanged_prefix() -> Result<()> {
    skip_if_remote!(Ok(()), "local review");
    skip_if_no_network!(Ok(()));
    let mut f = setup_with_followups(Some("A\nB\nC\nD\n"), Some("A\nB2\nC\nD\nE\n"), 2).await?;
    let before_requests = f._server.received_requests().await.unwrap();
    let before: serde_json::Value = serde_json::from_slice(&before_requests.last().unwrap().body)?;
    f.hunk(0, false).await?;
    f.hunk(1, false).await?;
    let repeated = f.all(false, false).await?;
    assert!(repeated.results.iter().all(|result| !result.changed));
    assert_eq!(
        f._server.received_requests().await.unwrap().len(),
        before_requests.len(),
        "review does not invoke inference"
    );
    fs::write(&f.path, "MANUAL AFTER REVIEW\n")?;
    let next = f.followup().await?;
    let facts = review_facts(&next);
    assert_eq!(facts.len(), 1);
    assert!(facts[0].contains("2 rollback operations confirmed 2 successful hunk reversions"));
    assert!(facts[0].contains("B2\\n"));
    assert!(facts[0].contains("E\\n"));
    let prefix = before["input"].as_array().unwrap();
    assert_eq!(
        &next["input"].as_array().unwrap()[..prefix.len()],
        prefix.as_slice(),
        "prior model input is not rewritten"
    );
    assert!(
        !serde_json::to_string(&next)?.contains("change_review_event_ids"),
        "host cursor is not model input"
    );
    assert_eq!(fs::read_to_string(&f.path)?, "MANUAL AFTER REVIEW\n");
    let repeated_input = f.followup().await?;
    assert_eq!(
        review_facts(&repeated_input),
        facts,
        "the next turn retains the original summary, without another append"
    );
    Ok(())
}

#[tokio::test]
async fn review_context_accept_and_conflict_do_not_inject_success() -> Result<()> {
    skip_if_remote!(Ok(()), "local review");
    skip_if_no_network!(Ok(()));
    for accept in [true, false] {
        let mut f = setup_with_followups(Some("old\n"), Some("abc\n"), 1).await?;
        if !accept {
            fs::write(&f.path, "USER\n")?;
        }
        let result = f.all(accept, true).await?;
        assert_eq!(
            result.results[0].state,
            if accept {
                ChangeReviewState::Accepted
            } else {
                ChangeReviewState::Conflict
            }
        );
        assert!(review_facts(&f.followup().await?).is_empty());
    }
    Ok(())
}

#[tokio::test]
async fn review_context_file_partial_success_is_truthful_in_model_input() -> Result<()> {
    skip_if_remote!(Ok(()), "local review");
    skip_if_no_network!(Ok(()));
    let mut f = setup_with_followups(
        Some("A\nB\nC\nD\nE\nF\nG\nH\nI\nJ\n"),
        Some("A\nB2\nC\nD\nE\nF\nG\nH\nI\nJ2\n"),
        1,
    )
    .await?;
    fs::write(&f.path, "A\nB2\nC\nD\nE\nF\nG\nH\nI\nUSER\n")?;
    f.all(false, true).await?;
    let facts = review_facts(&f.followup().await?);
    assert_eq!(facts.len(), 1);
    assert!(facts[0].contains("1 successful hunk reversions"));
    assert!(facts[0].contains("1 outcomes were not confirmed"));
    assert!(!facts[0].contains("J2\\n"));
    assert_eq!(
        fs::read_to_string(&f.path)?,
        "A\nB\nC\nD\nE\nF\nG\nH\nI\nUSER\n"
    );
    Ok(())
}

#[tokio::test]
async fn review_context_cold_resume_pending_then_delivered_no_duplicate() -> Result<()> {
    skip_if_remote!(Ok(()), "local review");
    skip_if_no_network!(Ok(()));
    let mut f = setup_with_followups(Some("old\n"), Some("abc\n"), 2).await?;
    f.all(false, true).await?;
    f.cold_resume().await?;
    let first = review_facts(&f.followup().await?);
    assert_eq!(first.len(), 1);
    assert!(first[0].contains("abc\\n"));
    f.cold_resume().await?;
    assert_eq!(review_facts(&f.followup().await?), first);
    Ok(())
}

#[tokio::test]
async fn review_context_manual_compaction_receives_pending_facts_without_replay() -> Result<()> {
    skip_if_remote!(Ok(()), "local review");
    skip_if_no_network!(Ok(()));
    let mut f = setup_with_followups(Some("old\n"), Some("abc\n"), 2).await?;
    f.all(false, true).await?;
    let _: ThreadCompactStartResponse = f
        .mcp
        .request(|request_id| ClientRequest::ThreadCompactStart {
            request_id,
            params: ThreadCompactStartParams {
                thread_id: f.set.thread_id.clone(),
            },
        })
        .await?;
    let _: TurnCompletedNotification = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        f.mcp.read_notification("turn/completed"),
    )
    .await??;
    let requests = f._server.received_requests().await.unwrap();
    let compact_input: serde_json::Value = serde_json::from_slice(&requests.last().unwrap().body)?;
    assert_eq!(review_facts(&compact_input).len(), 1);
    f.cold_resume().await?;
    assert!(
        review_facts(&f.followup().await?).is_empty(),
        "compacted review log must not be replayed"
    );
    Ok(())
}

#[tokio::test]
async fn two_hunks() -> Result<()> {
    skip_if_remote!(Ok(()), "ChangeSet MVP supports local patch files");
    skip_if_no_network!(Ok(()));
    let mut f = setup(Some("A\nB\nC\nD\n"), Some("A\nB2\nC\nD\nE\n")).await?;
    assert_eq!(f.set.files[0].hunks.len(), 2);
    let response = f.hunk(0, false).await?;
    assert_eq!(response.results[0].state, ChangeReviewState::Reverted);
    assert_eq!(fs::read_to_string(&f.path)?, "A\nB\nC\nD\nE\n");
    Ok(())
}

#[tokio::test]
async fn dirty_file_before_codex() -> Result<()> {
    skip_if_remote!(Ok(()), "local files");
    skip_if_no_network!(Ok(()));
    let mut f = setup(Some("USER CHANGE\nA\nB\n"), Some("USER CHANGE\nA2\nB\n")).await?;
    f.all(false, true).await?;
    assert_eq!(fs::read_to_string(&f.path)?, "USER CHANGE\nA\nB\n");
    Ok(())
}

#[tokio::test]
async fn unrelated_user_edit_after_codex() -> Result<()> {
    skip_if_remote!(Ok(()), "local files");
    skip_if_no_network!(Ok(()));
    let before = (0..210).map(|i| format!("line {i}\n")).collect::<String>();
    let after = before.replace("line 10\n", "CODEX\n");
    let mut f = setup(Some(&before), Some(&after)).await?;
    fs::write(&f.path, after.replace("line 200\n", "USER\n"))?;
    assert_eq!(
        f.hunk(0, false).await?.results[0].state,
        ChangeReviewState::Reverted
    );
    assert_eq!(
        fs::read_to_string(&f.path)?,
        before.replace("line 200\n", "USER\n")
    );
    Ok(())
}

#[tokio::test]
async fn same_region_user_edit_conflicts() -> Result<()> {
    skip_if_remote!(Ok(()), "local files");
    skip_if_no_network!(Ok(()));
    let mut f = setup(Some("A\nB\nC\n"), Some("A\nB2\nC\n")).await?;
    fs::write(&f.path, "A\nUSER\nC\n")?;
    assert_eq!(
        f.hunk(0, false).await?.results[0].state,
        ChangeReviewState::Conflict
    );
    assert_eq!(fs::read_to_string(&f.path)?, "A\nUSER\nC\n");
    Ok(())
}

#[tokio::test]
async fn new_file() -> Result<()> {
    skip_if_remote!(Ok(()), "local files");
    skip_if_no_network!(Ok(()));
    let mut f = setup(None, Some("NEW\n")).await?;
    assert_eq!(
        f.all(false, false).await?.results[0].state,
        ChangeReviewState::Reverted
    );
    assert!(!f.path.exists());
    let mut f = setup(None, Some("NEW\n")).await?;
    fs::write(&f.path, "USER\n")?;
    assert_eq!(
        f.all(false, false).await?.results[0].state,
        ChangeReviewState::Conflict
    );
    assert_eq!(fs::read_to_string(&f.path)?, "USER\n");
    Ok(())
}

#[tokio::test]
async fn deleted_file() -> Result<()> {
    skip_if_remote!(Ok(()), "local files");
    skip_if_no_network!(Ok(()));
    let mut f = setup(Some("BASELINE\n"), None).await?;
    f.all(false, false).await?;
    assert_eq!(fs::read_to_string(&f.path)?, "BASELINE\n");
    Ok(())
}

#[tokio::test]
async fn mixed_states_and_partial_result() -> Result<()> {
    skip_if_remote!(Ok(()), "local files");
    skip_if_no_network!(Ok(()));
    let before = (0..30).map(|i| format!("line {i}\n")).collect::<String>();
    let after = before
        .replace("line 2\n", "A\n")
        .replace("line 12\n", "B\n")
        .replace("line 22\n", "C\n");
    let mut f = setup(Some(&before), Some(&after)).await?;
    f.hunk(0, true).await?;
    fs::write(&f.path, after.replace("C\n", "USER\n"))?;
    f.hunk(2, false).await?;
    let response = f.all(false, false).await?;
    assert_eq!(
        response.results.iter().map(|r| r.state).collect::<Vec<_>>(),
        [
            ChangeReviewState::Accepted,
            ChangeReviewState::Reverted,
            ChangeReviewState::Conflict
        ]
    );
    assert_eq!(
        fs::read_to_string(&f.path)?,
        after.replace("B\n", "line 12\n").replace("C\n", "USER\n")
    );
    Ok(())
}

#[tokio::test]
async fn file_and_all_accept_preserve_files() -> Result<()> {
    skip_if_remote!(Ok(()), "local files");
    skip_if_no_network!(Ok(()));
    for file in [true, false] {
        let mut f = setup(Some("BASE\n"), Some("CODEX\n")).await?;
        f.all(true, file).await?;
        assert_eq!(f.set.state, ChangeReviewState::Accepted);
        assert!(!f.all(false, false).await?.results[0].changed);
        assert_eq!(fs::read_to_string(&f.path)?, "CODEX\n");
    }
    Ok(())
}

#[tokio::test]
async fn accept_one_line_changing_hunk_then_revert_the_others() -> Result<()> {
    skip_if_remote!(Ok(()), "local files");
    skip_if_no_network!(Ok(()));
    let before = (0..80).map(|i| format!("line {i}\n")).collect::<String>();
    let after = before
        .replace("line 10\n", "A1\nA2\nA3\n")
        .replace("line 30\nline 31\nline 32\n", "B\n")
        .replace("line 60\n", "C1\nC2\n");
    for accepted in 0..3 {
        for file in [false, true] {
            let mut f = setup(Some(&before), Some(&after)).await?;
            assert_eq!(f.set.files[0].hunks.len(), 3);
            let original_hunks = f.set.files[0].hunks.clone();
            assert_eq!(
                f.hunk(accepted, true).await?.results[0].state,
                ChangeReviewState::Accepted
            );
            assert_eq!(fs::read_to_string(&f.path)?, after);
            fs::write(&f.path, format!("USER PREFIX\n{after}"))?;
            let response = f.all(false, file).await?;
            let mut expected = before.clone();
            match accepted {
                0 => expected = expected.replace("line 10\n", "A1\nA2\nA3\n"),
                1 => expected = expected.replace("line 30\nline 31\nline 32\n", "B\n"),
                _ => expected = expected.replace("line 60\n", "C1\nC2\n"),
            }
            assert_eq!(
                fs::read_to_string(&f.path)?,
                format!("USER PREFIX\n{expected}")
            );
            for (index, result) in response.results.iter().enumerate() {
                assert_eq!(
                    result.state,
                    if index == accepted {
                        ChangeReviewState::Accepted
                    } else {
                        ChangeReviewState::Reverted
                    }
                );
                assert_eq!(result.changed, index != accepted);
                let hunk = &response.change_set.files[0].hunks[index];
                assert_eq!(hunk.id, original_hunks[index].id);
                assert_eq!(hunk.new_start, original_hunks[index].new_start);
                assert_eq!(hunk.patch, original_hunks[index].patch);
            }
            assert!(!f.hunk(accepted, false).await?.results[0].changed);
            assert_eq!(
                fs::read_to_string(&f.path)?,
                format!("USER PREFIX\n{expected}")
            );
        }
    }
    Ok(())
}

fn live_range(start_line: u32, line_count: u32) -> HunkLocationResult {
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
async fn locate_after_earlier_revert_user_shift_and_target_conflict() -> Result<()> {
    skip_if_remote!(Ok(()), "local files");
    skip_if_no_network!(Ok(()));
    let before = (0..40).map(|i| format!("line {i}\n")).collect::<String>();
    let after = before
        .replace("line 5\n", "line 5\nEXTRA A\nEXTRA B\n")
        .replace("line 25\n", "CODEX\n");
    let mut f = setup(Some(&before), Some(&after)).await?;
    assert_eq!(f.set.files[0].hunks.len(), 2);
    let historical = f.set.files[0].hunks[1].new_start;
    assert_eq!(historical, 28);
    assert_eq!(f.locate(1).await?, live_range(historical, 1));
    f.hunk(0, false).await?;
    assert_eq!(f.locate(1).await?, live_range(26, 1));
    assert_eq!(
        f.locate(0).await?,
        HunkLocationResult::NotPresent {
            reason: HunkNotPresentReason::Reverted
        }
    );
    let current = fs::read_to_string(&f.path)?;
    let user = format!("{}{}", "USER PREFIX\n".repeat(20), current);
    fs::write(&f.path, &user)?;
    assert_eq!(f.locate(1).await?, live_range(46, 1));
    assert_eq!(fs::read_to_string(&f.path)?, user);
    let changed = user.replace("CODEX\n", "USER TARGET\n");
    fs::write(&f.path, &changed)?;
    assert!(matches!(
        f.locate(1).await?,
        HunkLocationResult::Conflict { .. }
    ));
    assert_eq!(fs::read_to_string(&f.path)?, changed);
    // A successful locate does not grant permission to overwrite a later edit.
    let response = f.hunk(1, false).await?;
    assert_eq!(response.results[0].state, ChangeReviewState::Conflict);
    fs::write(&f.path, &user)?;
    assert_eq!(f.locate(1).await?, live_range(46, 1));
    assert_eq!(f.set.files[0].hunks[1].state, ChangeReviewState::Conflict);
    Ok(())
}

#[tokio::test]
async fn locate_accepted_and_deletion_anchor_over_rpc() -> Result<()> {
    skip_if_remote!(Ok(()), "local files");
    skip_if_no_network!(Ok(()));
    let before = (0..30).map(|i| format!("line {i}\n")).collect::<String>();
    let after = before
        .replace("line 10\nline 11\n", "")
        .replace("line 20\n", "CODEX\n");
    let mut f = setup(Some(&before), Some(&after)).await?;
    f.hunk(1, true).await?;
    assert_eq!(f.locate(1).await?, live_range(19, 1));
    assert_eq!(f.locate(0).await?, live_range(11, 0));
    fs::write(&f.path, format!("USER\n{after}"))?;
    assert_eq!(f.locate(0).await?, live_range(12, 0));
    f.hunk(0, false).await?;
    assert_eq!(f.locate(1).await?, live_range(22, 1));
    Ok(())
}

#[tokio::test]
async fn locate_added_deleted_and_unsupported_files_over_rpc() -> Result<()> {
    skip_if_remote!(Ok(()), "local files");
    skip_if_no_network!(Ok(()));
    let mut added = setup(None, Some("CODEX\n")).await?;
    assert_eq!(added.locate(0).await?, live_range(1, 1));
    fs::write(&added.path, [0xff])?;
    assert!(matches!(
        added.locate(0).await?,
        HunkLocationResult::Unsupported { .. }
    ));
    fs::remove_file(&added.path)?;
    assert_eq!(
        added.locate(0).await?,
        HunkLocationResult::NotPresent {
            reason: HunkNotPresentReason::FileMissing
        }
    );
    let mut deleted = setup(Some("OLD\n"), None).await?;
    assert_eq!(
        deleted.locate(0).await?,
        HunkLocationResult::NotPresent {
            reason: HunkNotPresentReason::FileDeleted
        }
    );
    fs::write(&deleted.path, "USER\n")?;
    assert!(matches!(
        deleted.locate(0).await?,
        HunkLocationResult::Conflict { .. }
    ));
    Ok(())
}
