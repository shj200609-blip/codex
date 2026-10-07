# ChangeSet review (v2 MVP)

## Repository investigation and implementation boundary

`core/src/tools/handlers/apply_patch.rs` handles both direct tool patches and
recognized shell `apply_patch` invocations. It delegates to
`tools/runtimes/apply_patch.rs`. The `codex-apply-patch` engine reads actual old
content immediately before each mutation and returns committed
`AppliedPatchDelta` records, including partial failures. No Git baseline is used.

`core/src/turn_diff_tracker.rs` already owns turn-scoped first baselines and
last exact patch results, keyed by environment plus path URI. This implementation
extends that tracker instead of maintaining a second baseline mechanism. An
explicit seen-path set retains nonexistent baselines across add/delete/add and
delete/recreate sequences. Interleaved changes between tracked mutations make
the affected path unsupported rather than attributing user content to Codex.

The tracker is created in `session/turn.rs`, shared with tools, and retained in
session state until `session/mod.rs` receives completion or interruption. That
terminal boundary freezes one logical ChangeSet. `CodexThread` exposes Core
read/review methods; app-server only selects operations, adapts errors, and
publishes notifications. Existing `turn/diff/updated`, `item/fileChange/*`, v1,
and thread-history `thread/revert` behavior remain available.

Arbitrary shell commands, scripts, hooks, MCP tools, background commands and
external processes lack exact mutation deltas. A watcher cannot reconstruct
their pre-write content or distinguish concurrent user writes. They are **not
covered**. Every response explicitly advertises `coverage: "applyPatchOnly"`.
If an untracked tool writes a file before its first tracked patch, that earlier
mutation is not part of the captured baseline.

## Lifecycle and domain

```text
Thread / Turn
  -> lazy first pre-mutation content (including nonexistent files)
  -> actual committed patch deltas
  -> normalized, finalized ChangeSet on completion or interruption
  -> Pending hunks
  -> Accepted / Reverted / Conflict
```

Models live in `codex-protocol::change_set` and are reused by Core and v2.
Each file supplies its environment ID, absolute path URI, kind, immutable
before/after content and hashes, hunks, aggregate state and unsupported reason.
Clients can open native diffs from this data without recalculating semantics.

Ranges follow unified diff conventions: nonempty starts are one-based; empty
ranges use the preceding line number, including zero at the start of a file.
Hunks use zero display-context lines so distinct edit runs can be reviewed
independently, even in small files. Matching uses separate internal context.
Line endings and missing final newlines are preserved exactly. Empty
created/deleted files have a presence-only hunk with empty patch and zero ranges.

UUIDv5 IDs use length-framed thread/turn identity, environment/path, original
range and patch bytes. Indices are never IDs. Finalized IDs/ranges/patches remain
unchanged during review. Decision revisions increase monotonically; clients
should ignore delayed notifications with an older revision.

`oldStart`/`newStart` address the immutable baseline/final Codex diff images,
not the current working file after individual reverts or user edits. IDE diff
views should use the supplied before/after contents for these ranges. Current
working-file navigation cannot assume that `newStart` is still its live line
number. Core rollback reconstructs its expected image from previously Reverted
hunks and adjusts the selected range for their line-count changes; Accepted
hunks remain in that image and contribute no additional offset.

Hunk decisions use Pending, Accepted, Reverted and Conflict. Aggregate file/set
states prioritize Conflict, then Pending, then Unsupported. Uniform terminal
decisions produce Accepted/Reverted; mixed terminal decisions and empty sets
produce Reviewed. Baselines remain retained after Accept.

## Historical Hunk Coordinates vs Live Hunk Location

`oldStart`/`oldLines` and `newStart`/`newLines` are **historical coordinates**:
the immutable baseline -> turn-final diff. They are suitable for displaying
historical diffs against the supplied images, and never change during review.
They must not be used to reveal a range in a partially reviewed current file.

Call `changeSet/hunk/locate` when the user clicks a hunk. The request follows
existing review addressing (including `fileId`, rather than `fileChangeId`):

```json
{
  "threadId": "thread-id",
  "turnId": "turn-id",
  "changeSetId": "set-id",
  "fileId": "file-id",
  "hunkId": "hunk-id"
}
```

The response always includes `changeSetId`, `fileId`, `hunkId`, and `path`.
`path` is the same absolute executor path URI as `ChangeSetFile.path`:

```json
{
  "changeSetId": "set-id",
  "fileId": "file-id",
  "hunkId": "hunk-id",
  "path": "file:///workspace/src/foo.rs",
  "result": {
    "status": "located",
    "startLine": 73,
    "lineCount": 8,
    "kind": "content"
  }
}
```

`result` is a tagged union:

| Status | Fields | Meaning |
| --- | --- | --- |
| `located` | `startLine`, `lineCount`, `kind` | Current filesystem range |
| `notPresent` | `reason`: `reverted`, `fileDeleted`, or `fileMissing` | No current Codex after-region to navigate to |
| `conflict` | `reason`: explanatory string | Exact target/context mismatch, ambiguity, recreated deleted path, or read failure |
| `unsupported` | `reason`: explanatory string | Unsupported tracked file or current file type/content |

`startLine` is **1-based**, consistent with v2 `TextPosition.line` file
locations. For `content`, it is the first line of the current after-side;
`lineCount` excludes matching context. VS Code clients subtract one when
constructing an editor position. Historical empty unified-diff ranges instead
use the preceding line number, which can be zero; do not apply that convention
to live ranges.

For a pure deletion, `kind` is `deletionAnchor`, `lineCount` is zero and
`startLine` means the insertion point **before** that current line. BOF is 1;
EOF is the number of content lines plus 1 (including for a missing final
newline); an emptied existing file anchors at 1. No after-content is invented.
An empty added file returns `filePresence` at 1 with zero lines. A deleted
whole file returns `notPresent/fileDeleted` while absent, and `conflict` if
recreated; it never invents a navigable line 1. A missing added/modified file
returns `notPresent/fileMissing`.

| Hunk state | Locate behavior |
| --- | --- |
| Pending | Match current contents and report the result |
| Accepted | Match identically; acceptance retains all matcher metadata |
| Reverted | `notPresent/reverted`, without reading the filesystem |
| Conflict | Retry matching; even a successful result leaves the decision Conflict |

Locate is read-only: it does not write files, update baseline, change decisions
or revision, or emit `changeSet/updated`. Missing sessions/turns, mismatched set
IDs, and unknown file/hunk IDs are invalid-params errors. Unsupported tracked
files retain no hunk IDs; for a known unsupported file, the file's unsupported
result takes precedence over hunk identity lookup. No live range is added to
`changeSet/read`, and no location notification stream is introduced.

Both Locate and Revert call `match_current_hunk`, which delegates modified-file
matching to the original exact `locate` matcher after `expected` adjusts for
previously reverted hunks. Created files share the existing whole-file equality
check; deleted files share the absence check. Revert then splices precisely the
matched range, revalidates before writing and verifies the result afterward.
The unchanged expected whole image can safely use its adjusted coordinate even
if its content repeats. When the image differs, both operations require unique
exact matching with anchored boundaries; neither guesses a nearest match.

Locate serializes with review decisions and excludes tracked patch execution
while reading. A successful result is only a point-in-time filesystem answer;
external writers can change it immediately afterward, and unsaved editor
buffers are not queried. Revert always matches again independently before
writing. Conservatively, edits within the three-line context or at an anchored
boundary can conflict even if target content is unchanged. Added files remain
whole-file presence transactions: partial user edits conflict. Existing binary,
non-UTF-8, >4 MiB, rename, remote and symlink limitations still apply.

## Requests

| Method | Params | Response |
| --- | --- | --- |
| `changeSet/read` | `threadId`, `turnId` | `{ changeSet: ChangeSet \| null }` |
| `changeSet/hunk/locate` | thread/turn/set IDs, `fileId`, `hunkId` | live location response |
| `changeSet/hunk/accept` | thread/turn/set IDs, `fileId`, `hunkId` | review response |
| `changeSet/hunk/revert` | thread/turn/set IDs, `fileId`, `hunkId` | review response |
| `changeSet/file/accept` | thread/turn/set IDs, `fileId` | review response |
| `changeSet/file/revert` | thread/turn/set IDs, `fileId` | review response |
| `changeSet/accept` | `threadId`, `turnId`, `changeSetId` | review response |
| `changeSet/revert` | `threadId`, `turnId`, `changeSetId` | review response |

Review responses contain the complete ChangeSet plus `results`, each containing
`fileId`, `hunkId`, `state`, `changed` and an optional explanation. Bulk calls
return outcomes for all selected hunks, including unchanged terminal states.
Unsupported files have no reviewable hunks and remain visible in the snapshot.
Partial success is explicit; bulk operations are not atomic across files/hunks.
`changed` means the review state changed (including Pending -> Conflict), not
necessarily that a file was written.

Accept is metadata-only. File/All operations process **Pending hunks only**.
Accepted, Reverted and Conflict decisions are terminal and are skipped; there
is no reopen or forced revert. Unknown identities are errors. Review requires
an idle thread, and admission remains locked throughout the operation. Read
returns null for a live/untracked turn or missing session data.

## Notifications

- `changeSet/created`: `{ changeSet }`, once at the terminal turn boundary.
- `changeSet/updated`: `{ changeSet, results }`, when any review state changes.

Notifications go to thread subscribers. Updated snapshots communicate file
aggregate changes and hunk decisions together; clients do not need polling.
This MVP does not publish mutable intermediate hunks during tool execution.
Existing item/diff notifications continue to provide live patch progress.

## Rollback safety

The baseline is the actual pre-Codex file, including all previously dirty
user content. Review never consults Git or restores an entire modified file
to simulate hunk undo.

For a modified file, Core reconstructs the expected Codex after-image with
previously reverted hunks removed. If current content equals that image, the
original adjusted coordinate is safe. Otherwise, the selected target and up
to three adjacent context lines must match exactly and uniquely in both the
expected and current images. Context reaching a file boundary is anchored.
Changed or ambiguous context is a conflict. Unrelated edits and line shifts
outside that context are preserved. Matching is conservative: an adjacent
user edit can conflict even if the edited target itself was unchanged.

The replacement contains only the selected hunk's baseline lines. Other hunks,
including Accepted ones, remain. Created files are removed only if their whole
current content still equals Codex's created content. Deleted files are
restored only if the path is still absent. Reads and writes reject symlinks
(including ancestor links), directories, non-UTF-8/binary and oversized files.
Content is re-read immediately before a mutation and verified afterward.
User-content mismatches detected before mutation do not write anything.

Core serializes reverts across threads and excludes tracked patch execution
through delta publication during revert. The same thread cannot start a new
turn while reviewing. Baselines and decisions are scoped to thread + turn,
not held in a global singleton.

**External concurrent writers remain a limitation:** the executor filesystem
interface does not provide atomic compare-and-swap writes/removes. An editor,
arbitrary shell process or another Codex process writing between the final
validation and filesystem operation can still race. Clients must quiesce such
writers during review. This implementation detects changes before/after the
write but does not claim an absolute cross-process no-overwrite guarantee.
An I/O/post-write verification failure is terminal Conflict with an explanation
requiring inspection; a failed filesystem write may have partially succeeded.
Atomic conditional filesystem mutation is required to close this gap.

## Storage, unsupported inputs and follow-ups

Storage is explicitly `sessionMemory`. VS Code reconnect/reload can read the
same loaded thread; process restart, thread unload or thread-history replacement
loses data. There are no workspace-local `.codex/changesets` files. Baselines are
kept until session disposal, even after terminal decisions. Long sessions can
retain substantial memory. The existing thread store persists canonical
history; a follow-up should add versioned baseline blobs and review records
under Codex-owned state storage, with retention, recovery and thread deletion
semantics, rather than adding large contents to ordinary history events.

Unsupported MVP cases:

- Rename (both affected paths are explicitly unsupported; no delete/add undo
  pretending to preserve rename semantics).
- Remote environments.
- NUL-containing text and files above 4 MiB per before/after image.
- Non-exact patch deltas, including failed writes or non-UTF-8 old content.
  Paths absent from an exact committed delta may not be enumerated.
- Interleaved outside edits to a path between tracked patches.
- Recovery of an already finalized/interrupted turn under the same turn ID:
  recovered-segment files are marked unsupported instead of reopening old
  decisions or treating the recovery point as the original turn baseline.
  Pending input drained before terminal publication reuses the original tracker.
- Cancellation of an in-flight filesystem operation before its exact delta is
  published can leave mutations that cannot be enumerated by this MVP.
- Arbitrary mutation pathways and external concurrent writers described above.
- File metadata restoration (permissions/timestamps), directory rollback,
  persistent review recovery, incremental review, conflict reopen.
- Hard-link aliases are not tracked as a shared file identity.

## Validation

Core filesystem tests cover selected-hunk isolation, dirty baseline, unrelated
shifted edits, same-region conflict, new/delete/recreated files, mixed decisions,
metadata-only accept, repeated mutations, absent baseline sequences, stable IDs,
multiple files, line-count shifts, interleaved edits, ambiguous context, binary/
huge/empty files, CRLF/missing-final-newline and symlink substitution.

The mixed Accept/Revert offset matrix covers 3,072 scenarios (now also asserting
Locate reports the exact range used by the next review operation): all 64 combinations
of insertion, deletion, expansion and contraction across three hunks, all eight
Accept/Revert decisions and all six operation orders. Each step verifies exact
file contents and immutable IDs/diff ranges. Additional cases combine accepted
line-changing hunks, user insertions/deletions, File/All Revert and Conflict.

App-server end-to-end tests in `tests/suite/v2/change_set.rs` run actual mock
model turns through patch execution, terminal publication, read/review RPCs,
update notifications and filesystem assertions. They cover the seven requested
acceptance scenarios plus File/All Accept. Existing tracker tests are run as
regression checks.
The offset integration test also accepts each of three line-changing hunks in
turn, uses both File and All Revert with a user-inserted prefix, and verifies
the accepted content, terminal decisions and update notifications.

Locator tests additionally cover original/accepted/reverted/conflict states,
positive/negative earlier-revert offsets, user insertions/deletions/edits,
duplicate targets, pure insertion/deletion (including BOF/EOF/empty anchors),
added/deleted/presence-only files, unsupported current contents and invalid IDs.
RPC tests run real turns, then verify earlier rollback, filesystem line shifts,
conflicts, read-only decisions/revisions, accepted hunks, deletion anchors and
file presence results.

Generate protocol artifacts with the repository's
`app-server-protocol/scripts/write_schema_fixtures.py`, including its
`--experimental` embedded export bundle and Python SDK generation. Generated
files must not be edited manually.
