//! Finalized, Git-independent review of exact patch mutations.
//!
//! The existing turn diff tracker owns lazy baselines. This module freezes its
//! net result and applies conservative, content-exact inverse edits. No fuzzy
//! patch matching is used: repeated/changed context produces a conflict.

use std::ops::Range;
use std::time::Duration;

use codex_exec_server::ExecutorFileSystem;
use codex_exec_server::GetMetadataOptions;
use codex_exec_server::ReadFileOptions;
use codex_exec_server::RemoveOptions;
use codex_exec_server::WriteFileOptions;
pub use codex_protocol::change_set::*;
use codex_utils_path_uri::PathUri;
use sha1::Digest;

pub const MAX_REVIEW_FILE_BYTES: usize = 4 * 1024 * 1024;

// Patches in independent threads may execute concurrently. Revert excludes all
// tracked patch executions, including their delta publication, across threads.
// This stores no baseline or review state; those remain turn/session scoped.
pub(crate) static REVIEW_MUTATION_GATE: tokio::sync::RwLock<()> =
    tokio::sync::RwLock::const_new(());

pub(crate) struct TrackedFile {
    pub environment_id: String,
    pub path: PathUri,
    pub before: Option<String>,
    pub after: Option<String>,
    pub unsupported: Option<String>,
}

/// Selection identifiers come from a frozen ChangeSet, never client paths.
pub enum ReviewSelection<'a> {
    Hunk { file_id: &'a str, hunk_id: &'a str },
    File { file_id: &'a str },
    All,
}

#[derive(Clone, Copy)]
pub enum ReviewAction {
    Accept,
    Revert,
}

struct InverseEdit {
    old: Range<usize>,
    new: Range<usize>,
    before: String,
}

struct ReviewFile {
    path: PathUri,
    // Immutable after-image plus edits already reverted. User edits never
    // become our expected image, which prevents adopting a user's content.
    after: Option<String>,
    edits: Vec<InverseEdit>,
}

pub(crate) struct ChangeSetReview {
    pub(crate) snapshot: ChangeSet,
    files: Vec<ReviewFile>,
}

fn fingerprint(value: &[u8]) -> String {
    format!("sha1:{:x}", sha1::Sha1::digest(value))
}

fn identity(parts: &[&str]) -> String {
    // Length framing prevents ambiguous path/content concatenations.
    let mut bytes = Vec::new();
    for part in parts {
        bytes.extend_from_slice(&(part.len() as u64).to_be_bytes());
        bytes.extend_from_slice(part.as_bytes());
    }
    uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, &bytes).to_string()
}

fn lines(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

fn start(range: &Range<usize>) -> u32 {
    if range.is_empty() {
        range.start as u32
    } else {
        range.start as u32 + 1
    }
}

fn aggregate(states: impl IntoIterator<Item = ChangeReviewState>) -> ChangeReviewState {
    let states = states.into_iter().collect::<Vec<_>>();
    for state in [
        ChangeReviewState::Conflict,
        ChangeReviewState::Pending,
        ChangeReviewState::Unsupported,
    ] {
        if states.contains(&state) {
            return state;
        }
    }
    match states.first() {
        Some(first) if states.iter().all(|state| state == first) => *first,
        _ => ChangeReviewState::Reviewed,
    }
}

impl ChangeSetReview {
    /// Capture only newly decided rollback outcomes after the safety checks and
    /// post-write verification. `changed` alone also includes conflicts/Accept.
    #[expect(
        clippy::expect_used,
        reason = "review outcomes contain only strings, integers and derived enums; serialization to memory is infallible"
    )]
    pub(crate) fn review_event(
        &self,
        scope: &str,
        action: ReviewAction,
        results: &[ChangeSetHunkResult],
    ) -> Option<codex_history::ChangeReviewEvent> {
        if !matches!(action, ReviewAction::Revert) {
            return None;
        }
        let mut outcomes = Vec::new();
        for result in results.iter().filter(|result| result.changed) {
            let fi = self
                .snapshot
                .files
                .iter()
                .position(|f| f.id == result.file_id)?;
            let file = &self.snapshot.files[fi];
            let hi = file.hunks.iter().position(|h| h.id == result.hunk_id)?;
            let edit = &self.files[fi].edits[hi];
            let after = self.files[fi].after.as_deref().unwrap_or("");
            let after_lines = lines(after);
            let removed_lines = &after_lines[edit.new.clone()];
            let removed_text = if result.state == ChangeReviewState::Reverted
                && !removed_lines.is_empty()
                && removed_lines.iter().map(|line| line.len()).sum::<usize>() <= 96
            {
                Some(removed_lines.concat())
            } else {
                None
            };
            outcomes.push(codex_history::ChangeReviewOutcome {
                file_id: file.id.clone(),
                hunk_id: result.hunk_id.clone(),
                path: file.path.clone(),
                kind: file.change_type,
                state: result.state,
                old_start: start(&edit.old),
                old_lines: edit.old.len() as u32,
                new_start: start(&edit.new),
                new_lines: edit.new.len() as u32,
                removed_text,
                reason: result
                    .message
                    .as_ref()
                    .map(|reason| reason.chars().take(256).collect()),
            });
        }
        if outcomes.is_empty() {
            return None;
        }
        let revision = self.snapshot.revision.to_string();
        let encoded = serde_json::to_string(&outcomes).expect("review outcomes are serializable");
        Some(codex_history::ChangeReviewEvent {
            id: identity(&[
                &self.snapshot.thread_id,
                &self.snapshot.id,
                &revision,
                "revert",
                &encoded,
            ]),
            thread_id: self.snapshot.thread_id.clone(),
            turn_id: self.snapshot.turn_id.clone(),
            change_set_id: self.snapshot.id.clone(),
            revision: self.snapshot.revision,
            scope: scope.to_owned(),
            outcomes,
        })
    }

    pub(crate) fn from_tracked(thread_id: &str, turn_id: &str, tracked: Vec<TrackedFile>) -> Self {
        let id = identity(&["changeSet", thread_id, turn_id]);
        let mut snapshot = ChangeSet {
            id: id.clone(),
            revision: 0,
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
            state: ChangeReviewState::Reviewed,
            coverage: "applyPatchOnly".to_string(),
            storage: "sessionMemory".to_string(),
            files: Vec::new(),
        };
        let mut files = Vec::new();
        for tracked in tracked {
            if tracked.before == tracked.after && tracked.unsupported.is_none() {
                continue;
            }
            let path = tracked.path.to_string();
            let file_id = identity(&[&id, &tracked.environment_id, &path]);
            let unsupported = tracked.unsupported.or_else(|| {
                [&tracked.before, &tracked.after]
                    .into_iter()
                    .flatten()
                    .find_map(|content| {
                        if content.len() > MAX_REVIEW_FILE_BYTES {
                            Some("File exceeds the 4 MiB text review limit".to_string())
                        } else if content.contains('\0') {
                            Some("Binary content is not reviewable".to_string())
                        } else {
                            None
                        }
                    })
            });
            let kind = match (&tracked.before, &tracked.after) {
                (None, _) => ChangeSetFileKind::Added,
                (_, None) => ChangeSetFileKind::Deleted,
                _ => ChangeSetFileKind::Modified,
            };
            let mut file = ChangeSetFile {
                id: file_id.clone(),
                environment_id: tracked.environment_id,
                path,
                change_type: kind,
                before_hash: tracked.before.as_ref().map(|c| fingerprint(c.as_bytes())),
                after_hash: tracked.after.as_ref().map(|c| fingerprint(c.as_bytes())),
                before_content: None,
                after_content: None,
                state: ChangeReviewState::Unsupported,
                hunks: Vec::new(),
                unsupported_reason: unsupported,
            };
            let mut edits = Vec::new();
            if file.unsupported_reason.is_none() {
                let before = tracked.before.as_deref().unwrap_or("");
                let after = tracked.after.as_deref().unwrap_or("");
                let diff = similar::TextDiff::configure()
                    .timeout(Duration::from_millis(100))
                    .diff_lines(before, after);
                for hunk in diff.unified_diff().context_radius(0).iter_hunks() {
                    let ops = hunk.ops();
                    let old = ops[0].old_range().start..ops[ops.len() - 1].old_range().end;
                    let new = ops[0].new_range().start..ops[ops.len() - 1].new_range().end;
                    let patch = hunk.to_string();
                    let hunk_id =
                        identity(&[&file_id, &format!("{}:{}", old.start, old.len()), &patch]);
                    file.hunks.push(ChangeHunk {
                        id: hunk_id,
                        old_start: start(&old),
                        old_lines: old.len() as u32,
                        new_start: start(&new),
                        new_lines: new.len() as u32,
                        patch,
                        state: ChangeReviewState::Pending,
                        conflict: None,
                    });
                    edits.push(InverseEdit {
                        before: diff.old_slices()[old.clone()].concat(),
                        old,
                        new,
                    });
                }
                // Presence-only changes (empty added/deleted file) still need a decision.
                if file.hunks.is_empty() && kind != ChangeSetFileKind::Modified {
                    file.hunks.push(ChangeHunk {
                        id: identity(&[&file_id, "presence"]),
                        old_start: 0,
                        old_lines: 0,
                        new_start: 0,
                        new_lines: 0,
                        patch: String::new(),
                        state: ChangeReviewState::Pending,
                        conflict: None,
                    });
                    edits.push(InverseEdit {
                        old: 0..0,
                        new: 0..0,
                        before: String::new(),
                    });
                }
                // Added/deleted files are a single presence transaction: user edits
                // must never be discarded by removing/restoring just part of a file.
                if kind != ChangeSetFileKind::Modified && file.hunks.len() > 1 {
                    file.unsupported_reason = Some("Unexpected full-file diff layout".to_string());
                    file.hunks.clear();
                    edits.clear();
                }
                if file.unsupported_reason.is_none() {
                    file.before_content = tracked.before.clone();
                    file.after_content = tracked.after.clone();
                    file.state = aggregate(file.hunks.iter().map(|h| h.state));
                }
            }
            files.push(ReviewFile {
                path: tracked.path,
                after: tracked.after,
                edits,
            });
            snapshot.files.push(file);
        }
        snapshot.state = aggregate(snapshot.files.iter().map(|f| f.state));
        Self { snapshot, files }
    }

    pub(crate) async fn review(
        &mut self,
        selection: ReviewSelection<'_>,
        action: ReviewAction,
        fs: &dyn ExecutorFileSystem,
    ) -> Result<Vec<ChangeSetHunkResult>, String> {
        let _mutation_guard = match action {
            ReviewAction::Revert => Some(REVIEW_MUTATION_GATE.write().await),
            ReviewAction::Accept => None,
        };
        let mut targets = Vec::new();
        let mut found = matches!(selection, ReviewSelection::All);
        for (fi, file) in self.snapshot.files.iter().enumerate() {
            let selected_file = match selection {
                ReviewSelection::All => true,
                ReviewSelection::File { file_id } | ReviewSelection::Hunk { file_id, .. } => {
                    file.id == file_id
                }
            };
            if !selected_file {
                continue;
            }
            if matches!(selection, ReviewSelection::File { .. }) {
                found = true;
            }
            for (hi, hunk) in file.hunks.iter().enumerate() {
                if let ReviewSelection::Hunk { hunk_id, .. } = selection
                    && hunk.id != hunk_id
                {
                    continue;
                }
                found = true;
                targets.push((fi, hi));
            }
        }
        if !found {
            return Err("Unknown file or hunk identity".to_string());
        }
        let mut results = Vec::new();
        for (fi, hi) in targets {
            let pending = self.snapshot.files[fi].hunks[hi].state == ChangeReviewState::Pending;
            if pending {
                match action {
                    ReviewAction::Accept => {
                        self.snapshot.files[fi].hunks[hi].state = ChangeReviewState::Accepted
                    }
                    ReviewAction::Revert => match self.revert(fi, hi, fs).await {
                        Ok(()) => {
                            self.snapshot.files[fi].hunks[hi].state = ChangeReviewState::Reverted
                        }
                        Err(reason) => {
                            let hunk = &mut self.snapshot.files[fi].hunks[hi];
                            hunk.state = ChangeReviewState::Conflict;
                            hunk.conflict = Some(reason);
                        }
                    },
                }
            }
            let file = &self.snapshot.files[fi];
            let hunk = &file.hunks[hi];
            results.push(ChangeSetHunkResult {
                file_id: file.id.clone(),
                hunk_id: hunk.id.clone(),
                state: hunk.state,
                changed: pending,
                message: hunk.conflict.clone(),
            });
        }
        for file in &mut self.snapshot.files {
            if file.unsupported_reason.is_none() {
                file.state = aggregate(file.hunks.iter().map(|h| h.state));
            }
        }
        self.snapshot.state = aggregate(self.snapshot.files.iter().map(|f| f.state));
        if results.iter().any(|r| r.changed) {
            self.snapshot.revision += 1;
        }
        Ok(results)
    }

    fn expected(&self, fi: usize, hi: usize) -> Result<(String, Range<usize>), String> {
        let file = &self.files[fi];
        let mut expected = lines(file.after.as_deref().unwrap_or(""))
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let mut selected = file.edits[hi].new.clone();
        // Original coordinates remain usable when we splice from right to left.
        for (index, edit) in file.edits.iter().enumerate().rev() {
            if self.snapshot.files[fi].hunks[index].state != ChangeReviewState::Reverted {
                continue;
            }
            expected.splice(
                edit.new.clone(),
                lines(&edit.before).into_iter().map(str::to_owned),
            );
            if edit.new.end <= file.edits[hi].new.start {
                let shift = edit.old.len() as isize - edit.new.len() as isize;
                selected.start = selected
                    .start
                    .checked_add_signed(shift)
                    .ok_or("Invalid inverse hunk range")?;
                selected.end = selected
                    .end
                    .checked_add_signed(shift)
                    .ok_or("Invalid inverse hunk range")?;
            }
        }
        Ok((expected.concat(), selected))
    }

    /// Shared presence checks and exact matcher. None denotes a safely absent
    /// deleted file, not a fabricated current range.
    fn match_current_hunk(
        &self,
        fi: usize,
        hi: usize,
        current: Option<&str>,
    ) -> Result<Option<Range<usize>>, String> {
        let file = &self.snapshot.files[fi];
        match file.change_type {
            ChangeSetFileKind::Added => {
                if current != file.after_content.as_deref() {
                    return Err("Created file was changed or removed after Codex".to_string());
                }
                Ok(Some(self.files[fi].edits[hi].new.clone()))
            }
            ChangeSetFileKind::Deleted => {
                if current.is_some() {
                    return Err("Deleted path has been recreated".to_string());
                }
                Ok(None)
            }
            ChangeSetFileKind::Modified => {
                let current = current.ok_or("Modified file no longer exists")?;
                let (expected, range) = self.expected(fi, hi)?;
                locate(&expected, current, range).map(Some)
            }
        }
    }

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "the review mutation gate must exclude tracked writes throughout the read and exact match"
    )]
    pub(crate) async fn locate_hunk(
        &self,
        file_id: &str,
        hunk_id: &str,
        fs: &dyn ExecutorFileSystem,
    ) -> Result<ChangeSetHunkLocateResponse, String> {
        // Exclude tracked mutations while reading, without writing anything.
        let _mutation_guard = REVIEW_MUTATION_GATE.write().await;
        let fi = self
            .snapshot
            .files
            .iter()
            .position(|f| f.id == file_id)
            .ok_or("Unknown file identity")?;
        let file = &self.snapshot.files[fi];
        let result = if let Some(reason) = &file.unsupported_reason {
            // Unsupported files retain no hunk identities. Report their file
            // limitation before attempting a hunk lookup or filesystem read.
            HunkLocationResult::Unsupported {
                reason: reason.clone(),
            }
        } else {
            let hi = file
                .hunks
                .iter()
                .position(|h| h.id == hunk_id)
                .ok_or("Unknown hunk identity")?;
            if file.hunks[hi].state == ChangeReviewState::Reverted {
                HunkLocationResult::NotPresent {
                    reason: HunkNotPresentReason::Reverted,
                }
            } else {
                match read_review_text(fs, &self.files[fi].path).await {
                    Err(ReadTextError::Unsupported(reason)) => {
                        HunkLocationResult::Unsupported { reason }
                    }
                    Err(ReadTextError::Conflict(reason)) => HunkLocationResult::Conflict { reason },
                    Ok(current) => match self.match_current_hunk(fi, hi, current.as_deref()) {
                        Ok(Some(range)) => HunkLocationResult::Located {
                            start_line: range.start as u32 + 1,
                            line_count: range.len() as u32,
                            kind: if !range.is_empty() {
                                CurrentHunkRangeKind::Content
                            } else if file.change_type == ChangeSetFileKind::Added {
                                CurrentHunkRangeKind::FilePresence
                            } else {
                                CurrentHunkRangeKind::DeletionAnchor
                            },
                        },
                        Ok(None) => HunkLocationResult::NotPresent {
                            reason: HunkNotPresentReason::FileDeleted,
                        },
                        Err(_) if current.is_none() => HunkLocationResult::NotPresent {
                            reason: HunkNotPresentReason::FileMissing,
                        },
                        Err(reason) => HunkLocationResult::Conflict { reason },
                    },
                }
            }
        };
        Ok(ChangeSetHunkLocateResponse {
            change_set_id: self.snapshot.id.clone(),
            file_id: file.id.clone(),
            hunk_id: hunk_id.to_string(),
            path: file.path.clone(),
            result,
        })
    }

    async fn revert(
        &self,
        fi: usize,
        hi: usize,
        fs: &dyn ExecutorFileSystem,
    ) -> Result<(), String> {
        let file = &self.snapshot.files[fi];
        let path = &self.files[fi].path;
        let current = read_text(fs, path).await?;
        let target = self.match_current_hunk(fi, hi, current.as_deref())?;
        let result = match file.change_type {
            ChangeSetFileKind::Added => None,
            ChangeSetFileKind::Deleted => file.before_content.clone(),
            ChangeSetFileKind::Modified => {
                let current = current.as_deref().ok_or("Modified file no longer exists")?;
                let target = target.ok_or("Invalid inverse hunk range")?;
                let mut content = lines(current)
                    .into_iter()
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                content.splice(
                    target,
                    lines(&self.files[fi].edits[hi].before)
                        .into_iter()
                        .map(str::to_owned),
                );
                Some(content.concat())
            }
        };
        // Re-read immediately before mutation. Executor APIs do not offer atomic
        // compare-and-swap against external writers; callers must quiesce those.
        if read_text(fs, path).await? != current {
            return Err("File changed while preparing rollback".to_string());
        }
        match &result {
            Some(content) => {
                fs.write_file(
                    path,
                    content.as_bytes().to_vec(),
                    WriteFileOptions {
                        follow_symlinks: false,
                    },
                    None,
                )
                .await
            }
            None => {
                fs.remove(
                    path,
                    RemoveOptions {
                        recursive: false,
                        force: false,
                        follow_symlinks: false,
                    },
                    None,
                )
                .await
            }
        }
        .map_err(|error| format!("Rollback I/O failed; inspect the file: {error}"))?;
        if read_text(fs, path).await? != result {
            return Err("File changed during rollback; inspect current content".to_string());
        }
        Ok(())
    }
}

/// Exact matching with three lines of context and anchored file boundaries.
/// The unchanged whole image can use its original coordinate, even if repeated.
fn locate(expected: &str, current: &str, range: Range<usize>) -> Result<Range<usize>, String> {
    if expected == current {
        return Ok(range);
    }
    let expected = lines(expected);
    let current = lines(current);
    let left = range.start.saturating_sub(3);
    let right = (range.end + 3).min(expected.len());
    let needle = &expected[left..right];
    if needle.is_empty() {
        return Err("An empty target has no safe context".to_string());
    }
    let original_matches = (0..=expected.len().saturating_sub(needle.len()))
        .filter(|&i| {
            expected.get(i..i + needle.len()) == Some(needle)
                && (left != 0 || i == 0)
                && (right != expected.len() || i + needle.len() == expected.len())
        })
        .count();
    if original_matches != 1 {
        return Err("Target context was ambiguous in the Codex result".to_string());
    }
    let candidates = (0..=current.len().saturating_sub(needle.len()))
        .filter(|&i| {
            current.get(i..i + needle.len()) == Some(needle)
                && (left != 0 || i == 0)
                && (right != expected.len() || i + needle.len() == current.len())
        })
        .collect::<Vec<_>>();
    if candidates.len() != 1 {
        return Err("Target or context changed, or matches more than one location".to_string());
    }
    let position = candidates[0] + range.start - left;
    Ok(position..position + range.len())
}

async fn read_text(fs: &dyn ExecutorFileSystem, path: &PathUri) -> Result<Option<String>, String> {
    read_review_text(fs, path)
        .await
        .map_err(|error| match error {
            ReadTextError::Unsupported(reason) | ReadTextError::Conflict(reason) => reason,
        })
}

enum ReadTextError {
    Unsupported(String),
    Conflict(String),
}

async fn read_review_text(
    fs: &dyn ExecutorFileSystem,
    path: &PathUri,
) -> Result<Option<String>, ReadTextError> {
    match fs
        .get_metadata(
            path,
            GetMetadataOptions {
                follow_symlinks: false,
            },
            None,
        )
        .await
    {
        Ok(metadata)
            if metadata.is_file
                && !metadata.is_symlink
                && metadata.size <= MAX_REVIEW_FILE_BYTES as u64 => {}
        Ok(_) => {
            return Err(ReadTextError::Unsupported(
                "Path is not a supported regular text file".to_string(),
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::InvalidInput | std::io::ErrorKind::Unsupported
            ) =>
        {
            return Err(ReadTextError::Unsupported(format!(
                "Cannot inspect path: {error}"
            )));
        }
        Err(error) => {
            return Err(ReadTextError::Conflict(format!(
                "Cannot inspect path: {error}"
            )));
        }
    }
    let content = fs
        .read_file_text(
            path,
            ReadFileOptions {
                follow_symlinks: false,
            },
            None,
        )
        .await
        .map_err(|error| {
            let reason = format!("Cannot read UTF-8 file: {error}");
            if matches!(
                error.kind(),
                std::io::ErrorKind::InvalidData
                    | std::io::ErrorKind::InvalidInput
                    | std::io::ErrorKind::Unsupported
            ) {
                ReadTextError::Unsupported(reason)
            } else {
                ReadTextError::Conflict(reason)
            }
        })?;
    if content.len() > MAX_REVIEW_FILE_BYTES || content.contains('\0') {
        return Err(ReadTextError::Unsupported(
            "File became too large or binary".to_string(),
        ));
    }
    Ok(Some(content))
}

#[cfg(test)]
#[path = "change_set_tests.rs"]
mod tests;
