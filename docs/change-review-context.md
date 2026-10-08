# Review rollback facts in model context

Core now supplies one bounded, deterministic summary of Changes Review rollbacks
to the next sampling/compaction request. Review clicks do not initiate inference.
Accept is metadata-only and adds no message. Coverage stays `applyPatchOnly`;
ChangeSet/baseline storage stays `sessionMemory`. Only small facts and delivery
cursors persist. No package version or review RPC changes are required.

## Verified build checkout

The active layout is `codex-ide/{codex,vscode-extension}`. The installed Changes
Review 0.5.0 bundle matches the sibling `vscode-extension/dist/extension.js`
SHA-256 `4260816690eaeb381d7eb481846e91cf739cf2b1a4a849076b6bac52b57fd7fe`.
The nested `codex/vscode-extension` has no built bundle/VSIX and was not edited.
The shared IDE connection uses `codex/codex-rs/target/debug/codex` and
`ws://127.0.0.1:4510/`. Loading a rebuilt fork into the running shared server is a
separately authorized step. Isolated automated tests do not restart port 4510 or
reload VS Code. The authorized live switch is recorded below.
The live listener's command was also verified to be that exact debug `codex`
executable with `app-server --listen ws://127.0.0.1:4510`.

No applicable AGENTS.md was found in workspace ancestors, the Codex root or Core
subtree. The only discovered AGENTS.md is specific to TUI bottom-pane work.

### If the UI still answers from pre-rollback history

A rebuilt executable does not update an already running App Server. The
compatibility version intentionally stays the same, so comparing `--version`
alone cannot establish that the process loaded this implementation. Compare the
4510 listener's PID/start time with the executable's modification time, then
inspect that exact thread's rollout for `change_review` records and the delivered
`<change_review_facts>` message.

The reported 18:49 UI failure on 2026-10-07 was checked against its thread's
rollout: it had no review event or summary. The shared process had started at
10:34, before the new executable was built at 16:30; the file rollback itself had
succeeded. This was an old-runtime acceptance attempt. Switching the server must
be authorized because it discards session-memory ChangeSets/baselines. An old
unrecorded rollback is not reconstructed from missing file contents or rewritten
assistant messages; repeat the acceptance with a newly tracked edit after loading
the new runtime.

## Authority and context

```text
review RPC -> CodexThread::review_change_set -> Session::review_change_set
  -> ChangeSetReview::review (existing matcher, mutation, post-write verification)
  -> small RolloutItem::ChangeReview fact + session pending state
next regular/compact task -> Session::sync_review_context
  -> one developer ResponseItemEnvelope appended to the history tail
  -> ContextManager::for_prompt -> actual model request
```

Success requires `changed && state == Reverted`. `changed` alone also includes
Pending-to-Conflict. Conflict and I/O/post-write failures are retained as
unconfirmed outcomes; mixed summaries count them without claiming success or
unchanged files. Duplicate terminal decisions produce no event. Invalid IDs and
active-thread errors return before recording facts. Accept adds no rollback event.
The idle-thread restriction, review mutex, mutation gate, exact matching and
protection of later user edits are unchanged.

Event UUIDv5 identities derive from framed origin thread, ChangeSet, resulting
revision, action, and actual changed outcomes. The local journal stores origin
turn, hunk/file/all scope, file/hunk IDs, paths, historical ranges, file kinds,
outcomes, bounded reasons and optional short removed text. No full images, diffs
or baseline contents are added. Event IDs deduplicate retries and reconnects.

The model message is an explicitly labeled harness fact (`role: developer`), not
a synthetic user request, assistant action or tool result. It identifies the
file and successful historical range, optionally with removed text `"abc\n"`.
It says the fact is from review time, not a current snapshot or permanent ban,
and to read the current file before editing. Paths and excerpts are JSON quoted
with angle brackets escaped; they are data rather than instructions.

`MAX_REVIEW_SUMMARY_BYTES = 2048` limits the entire UTF-8 message, including
framing, guidance and omission notices. Exact edit excerpts are optional and at
most 96 bytes, extracted from the selected immutable after-side edit. If details
exceed the budget, the message switches to operation/hunk/file counts and counts
by path. Excess identifiers and all omitted details are declared explicitly.
It never equates partial success with reverting the complete ChangeSet. Detailed
metadata and delivery IDs remain host-only.

## Persistence, retries and compaction

The operation journal is appended/flushed before the review response is
acknowledged. On persistence failure, facts stay pending in memory; successful
hunk results warn that recovery is not yet durable. Actual filesystem success
is not converted into a fictional conflict.

The summary and `CodexHarnessMetadata.change_review_event_ids` share **one JSONL
record**. An independent small append task finishes if its awaiting regular task
is cancelled. History append and cursor commit occur under the state lock without
an intervening await. An ambiguous append acknowledgement freezes the summary
ID; retry first flushes and checks durable history for that ID before appending.
A failed final flush stays a pending barrier. Preparation alone consumes nothing.

Resume reconstructs facts and delivery markers from the supplied rollout. Pending
facts survive orderly cold recovery without recovering ChangeSets/baselines.
An already appended summary follows normal replay and is not appended twice.
Old rollouts without the optional metadata still load. The new record is local
rollout state; generated App Server wire APIs remain unchanged.

Sync precedes pre-turn and standalone manual compaction. Inline/post-turn
compaction has already passed that boundary. Full-history recovery sees prior
delivery markers. Paginated recovery may receive only the newest compaction and
its suffix: consumed facts were supplied to compaction, and later operations are
in the suffix. No full audit-log replay is added after compaction. Retaining the
meaning of an old fact depends on the existing compactor's output, as with other
history; there is no permanent verbatim audit trail in model context.

Filesystem mutation and journal append are not one atomic transaction. Abrupt
death between them can leave an unrecorded write; no filesystem WAL/checkpoint
system is implemented. Ordinary acknowledged review, request-boundary
cancellation and orderly cold recovery are covered. Existing external-writer
compare-and-swap limitations remain.

## Context cost and cache accounting

Run from `codex/codex-rs`:

```sh
cargo test -p codex-core --lib review_context_measurement --offline -- --nocapture
```

The single-hunk `abc` fixture (`file:///workspace/test.txt`, `turn-1`) measures
**666 UTF-8 bytes / 666 Unicode scalars**. The repository's `approx_token_count`
heuristic estimates **167 tokens**, excluding role/message framing. Its formula
is `ceil(UTF-8 bytes / 4)`, not a provider tokenizer. The 2,048-byte ceiling gives
512 by that heuristic; real tokenizers and non-ASCII paths can differ. Real turn
IDs/paths change the example cost within the byte ceiling. No-event/Accept turns
append zero review-message bytes. Later turns retain the existing summary instead
of appending copies.

| Quantity | Evidence/measurement |
| --- | --- |
| Added input | Measured summary bytes and reproducible text-token heuristic, plus provider framing |
| Total input tokens | History + tools + instructions + user input + summary; actual provider `input_tokens` is required |
| Cached input tokens | Actual provider cached-input usage; mock tests establish no cache hit |
| Non-cached input tokens | Actual input minus actual cached input; unavailable without real usage |

The integration prefix assertion proves prior input items are unchanged, not that
they are cached. The initial summary is a new suffix; later it may be in a shared
prefix, subject to provider eligibility, minimum lengths, routing and retention.
Total input includes cached tokens. Never treat stable bytes as guaranteed cache
hits or mock synthetic usage as production measurements.

## Copilot inspiration and differences

The public [Copilot Edit prompt](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/extension/prompts/node/panel/editCodePrompt.tsx)
was inspected on 2026-10-07: Accepted/Rejected/Undecided state declarations,
document summarization budgets and file/version-pair deduplication motivate the
explicit facts, budget and delivery identities here. Codex uses authoritative
Core outcomes rather than editor versions. It appends through its own
history/rollout. It does not attach current documents, rewrite old user/assistant
messages, remove historical file tags, delete a Turn or implement chat checkpoints.
Code generates the summary; no extra model is invoked.

## Acceptance: add abc, undo, ask about edits

After authorization to load the rebuilt fork into the shared server:

1. Connect the producer and Changes Review 0.5.0 to `ws://127.0.0.1:4510/`.
   Keep an existing `test.txt` with known contents.
2. Ask the producer to use `apply_patch` to add a separate `abc` line and an
   unrelated distant edit. Wait for turn completion.
3. Revert only `abc` in Changes Review. Confirm Reverted, the line is gone and
   the other edit remains; the click must not start inference. Optionally edit
   the file manually afterward.
4. In the same thread ask: “我刚才通过审核界面撤销了哪些修改？请只说明记录，
   不要编辑文件。” Check that the answer attributes `abc` removal to user review,
   distinguishes the remaining edit and treats current content as requiring an
   actual read. Inspect the request/rollout for one `<change_review_facts>`
   developer message with its host-only delivery cursor.
5. Ask again; no second summary should be appended. Repeat separately with File
   Revert, Accept and a manually edited target that must conflict.

## Automated validation and limits

```sh
cargo test -p codex-core --lib review_context --offline -- --nocapture
cargo test -p codex-core --lib change_set::tests --offline
env -u CODEX_SANDBOX_NETWORK_DISABLED cargo test -p codex-app-server --test all \
  suite::v2::change_set --offline -- --test-threads=1
```

Isolated App Server tests use local mock sockets and temporary Codex homes. They
assert real request bodies, unchanged preceding input, no inference on review,
merged and partial outcomes, Accept/conflict omission, later manual edits,
pending/delivered cold resume and manual compaction without journal replay.
Core tests cover budgets, concurrency, cancellation and ambiguous-ack retries;
the existing safety matrix covers 3,072 mixed Accept/Revert scenarios.

Validation on 2026-10-07:

- Context tests: 14 passed, including the reproducible 666-byte measurement.
- ChangeSet safety tests: 41 passed; three also occur in the context filter.
- App Server ChangeSet tests: 17 passed. The five context integration tests were
  rerun after the final retry changes and all passed.
- The actual fork binary built with `cargo build -p codex-cli --bin codex
  --offline`; its version remains `0.162.0-alpha.2`.
- Library lint passed with `cargo clippy -p codex-core -p codex-history
  -p codex-rollout -p codex-thread-store --lib --no-deps --offline -- -D warnings`.
  `git diff --check` passed.
- Expanding that strict lint to `--tests` is blocked by four diagnostics verified
  in the original HEAD: unused `body_json` in
  `core/tests/suite/openai_file_mcp.rs:47`, unused `ReasoningEffort` in
  `core/tests/suite/scenarios.rs:42`, and an unnecessary borrow plus a lock held
  across `await` in `core/src/change_set_tests.rs` (current lines 839 and 947;
  original lines 712 and 820). They are not reported as a passing test-target
  lint check.

Physical VS Code UI interaction, a production model's interpretation, real cache
usage and abrupt-crash filesystem/journal atomicity are outside automatic coverage.
The initial automated run did not restart the shared 4510 process, which still
ran its previously loaded binary. The later authorized switch and live acceptance
are recorded below. No commit or push was performed.

## Authorized live acceptance on 2026-10-07

After the user authorized completion, all three loaded threads were checked idle.
The old PID 49715 exited through graceful SIGHUP. PID 63931 started at 19:05
America/Toronto from the same debug binary, normal Codex home/config and endpoint
`ws://127.0.0.1:4510`. Protocol initialization and the new listener were verified;
the compatibility version remains `0.162.0-alpha.2`. The temporary manual-server
PID record was updated. The existing `test2.txt` remained exactly `qwe4\n`.

A real GPT-5.6 Luna thread (`01a118a0-28a3-7181-97c5-e97950fb02a8`) used
`apply_patch` to change the first line of the dedicated
`review-context-acceptance.txt` fixture and add a distant `abc` line. Two distinct
hunks were retained. The actual `changeSet/hunk/revert` RPC successfully reverted
only `abc`; the other hunk stayed Pending and its contents stayed present.
Immediately afterward the rollout had one review event, zero summaries and no
new inference turn. The next real model turn appended one 753-byte developer
fact message and the model answered that `abc` had been rolled back, then read
the current file and correctly retained the other change. A second question
returned: “你撤销了本次修改中末尾新增的 `abc` 行。” The rollout still had exactly
one event and one summary. User messages did not supply the rollback fact.

The service reported the following input usage (these are whole sampling
requests, including their existing context, tools and new user input):

| Sampling request | Total input | Cached input | Non-cached input |
| --- | ---: | ---: | ---: |
| First request after rollback | 18,409 | 17,152 | 1,257 |
| File-read follow-up in that turn | 18,603 | 18,176 | 427 |
| Entire next turn (sum of both requests) | 37,012 | 35,328 | 1,684 |
| Repeated question | 18,787 | 18,176 | 611 |

The measured review text adds 753 UTF-8 bytes / 753 Unicode scalars, or 189 tokens
by the repository heuristic, excluding message framing. It is not valid to
attribute all non-cached tokens or differences between requests to that summary.
These observed cache hits do not guarantee future hits. Detailed local acceptance
evidence is in `/private/tmp/codex-review-context-live-20261007.json`; the thread's
normal rollout contains the authoritative event and appended fact message.

Physical new-runtime UI review was initially blocked while the Mac was locked; the
successful rollback above used the same authoritative RPC as the extension.
The IDE showed a disconnected-chat error after the server switch. Clicking its
Retry button unexpectedly reloaded the VS Code window: the installed extension
handles `codex-app-server-restart` with `workbench.action.reloadWindow`. This
was an unintended side effect and is recorded rather than claiming no reload.
No further reload was initiated. After unlocking, the physical menu check was
completed as recorded below.

### Physical VS Code follow-up

The actual IDE producer created thread `01a11933-ab24-7962-a288-d73017d167c5`
(source `vscode`, visible title “更新 review-context-ui-acceptance”) and used
`apply_patch` on the separate `review-context-ui-acceptance.txt` fixture. It changed
`qwe4` to `qwe4-ui-kept` and appended `abc`, producing two separate Pending hunks.
The real Changes Review context menu's **Revert Change** reverted only `abc`.
The UI then showed Reverted for `abc` and Pending for the retained first-line
change. Filesystem and rollout assertions confirmed one successful review event,
zero summaries and no new model turn immediately after that menu action.

In the same visible IDE chat, the next GPT-6.1 Sol turn answered:
“随后你通过审查界面回退了新增的 `abc` 行。” It read the current file and displayed
the retained first-line change without `abc`. The real menu's **Accept Change**
then marked the retained hunk Accepted, without changing the file or adding an
event, summary or inference turn. A repeated question, after the user selected
GPT-5.6 Luna, returned “你撤销了末尾新增的 `abc` 行。” Both model choices saw the
same persisted fact. The rollout still contained exactly one event and one
developer summary; its pre-review byte prefix matched the saved SHA-256 exactly.
The existing `test2.txt` and the original unsent new-chat draft were preserved.
No server restart, window reload, commit or push occurred during this follow-up.

The UI fixture's summary measures 756 UTF-8 bytes / 756 Unicode scalars, or 189
tokens by the repository heuristic, excluding message framing. Production usage:

| UI sampling request | Total input | Cached input | Non-cached input |
| --- | ---: | ---: | ---: |
| Sol: first request after rollback | 20,311 | 19,840 | 471 |
| Sol: file-read follow-up | 20,494 | 20,096 | 398 |
| Entire Sol turn (both requests) | 40,805 | 39,936 | 869 |
| Luna: repeated question after model switch | 26,044 | 0 | 26,044 |

These are complete requests, not the review text's isolated token cost. The
uncached repeated question after a model switch also demonstrates why unchanged
history does not guarantee a cache hit. Local structured evidence is retained in
`/private/tmp/codex-review-context-ui-live-20261007.json` and the normal rollout.
Physical coverage now includes partial hunk rollback, metadata-only Accept,
next-turn interpretation and repeated-question deduplication. File Revert,
conflicts/failures, later manual edits, budgets, cancellation/retry, cold recovery
and compaction remain covered by the automated suites rather than additional
physical menu runs. Filesystem/journal abrupt-crash atomicity remains unsupported.
