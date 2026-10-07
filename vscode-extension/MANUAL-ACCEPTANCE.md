# Native VS Code UI acceptance

Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run smoke` first.
For UI testing, open `codex-changes.code-workspace`, press F5, and open a temporary
workspace in the Extension Development Host. Configure shared WebSocket mode and
connect an existing producer to the **same** fork App Server, as documented in
README. No Chat UI is provided by this extension. Use a canonical directory path;
Core deliberately rejects symlink ancestors.

Start with two saved text files, `src/a.rs` and `src/b.rs`, containing at least
40 distinct lines each. Ask the producer to apply two separated patch edits in
each file, with at least seven unchanged lines between them. Include a pure
deletion, an added file (including an empty file) and a deleted file in another
turn. Retain a copy of initial contents for comparison.

| Scenario                 | Action                                                                     | Expected native UI / disk behavior                                                                                        |
| ------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Two files / two hunks    | Complete a tracked patch turn                                              | CHANGES automatically lists both files and their distinct pending hunks; coverage banner explicitly says apply_patch only |
| Inline hunk actions      | Open a saved current file or native diff                                   | Accept/Revert appear at Core live positions; baseline has none; refs identify each set/file/hunk                          |
| Inline decisions         | Click inline Accept and Revert                                             | Tree/progress/actions refresh; terminal old buttons cannot send review RPC                                                |
| Peer decision            | Accept from a second connected client                                      | Observer inline state updates; its old action is rejected without mutation                                                |
| Selected bulk target     | Select an older Tree set and use title/file bulk action                    | Only that set changes; no implicit newest target                                                                          |
| Open hunk 2              | Click `a.rs` hunk 2                                                        | Native baseline/current diff opens at the locator's live range, not historical `newStart`                                 |
| Partial rollback shifts  | Revert `a.rs` hunk 1, then click hunk 2                                    | Hunk 1 shows Reverted; remaining diff and scroll reflect its shifted current location                                     |
| User insertion           | Insert and save 20 lines before hunk 2, outside matching context; click it | Current disk location moves by 20 lines and the diff scrolls there                                                        |
| User overlap             | Modify/save a pending target region, then Revert                           | Core refuses rollback; hunk/file become Conflict with a warning and Open Diff remains available; user edit survives       |
| Mixed decisions          | On a three-hunk fixture Accept A, Revert B, leave C                        | Tree shows Accepted / Reverted / Pending; accepted and reverted nodes no longer offer their old review actions            |
| Partial Revert All       | Have pending A, user-modified pending B, accepted C; Revert All            | A becomes Reverted, B Conflict, C stays Accepted; actual per-hunk outcomes appear, without a blanket failure              |
| Deletion anchor          | Click a pure deletion at BOF, middle, EOF or in an emptied file            | Diff reveals a valid zero-length cursor anchor; no negative/out-of-range selection                                        |
| Added file               | Click an added file, then an empty added hunk                              | Empty baseline vs real current file; empty presence hunk opens without forced selection                                   |
| Deleted file             | Click a deleted file / hunk                                                | Baseline vs empty virtual current side, title identifies absence; no attempt to open an absent real file                  |
| Reverted navigation      | Click a reverted hunk                                                      | “This change has already been reverted.”; no stale-coordinate jump                                                        |
| Shared-server reload     | Reload Extension Host while server remains alive                           | Both retained consecutive sets recover; server revision and decisions remain accurate                                     |
| Server restart           | Stop/restart shared server, then Restart / Reconnect                       | Disconnected transitions to Ready; missing saved data clears and No active changes appears                                |
| Owned stdio reload       | Run stdio mode, reload/restart Extension Host                              | Its owned child is replaced; lost session data clears without a crash                                                     |
| Unsaved buffer           | Edit without saving, click hunk, then Accept/Revert                        | Diff warns and omits disk-derived selection; review is blocked until save/discard                                         |
| Unsupported              | Review a server-marked unsupported file                                    | Question/state explanation remains visible; Accept/Revert are unavailable                                                 |
| Shared producer approval | Trigger a tool approval in the producer while review is connected          | Producer approval UI owns the request; review client neither grants nor rejects it                                        |
| File-level opening       | Click a file and multiple hunks in it                                      | All reuse one baseline URI; current side includes partial rollback and saved edits                                        |
| Multiple known sets      | Finish another tracked turn                                                | Stable ChangeSet roots appear; Accept/Revert All honors the selected Tree set or requests an explicit target              |

Observe Status Bar **Connecting / Ready / Disconnected** and inspect **Codex
Changes: Show App Server Log** when diagnosing transport/unsupported-method issues.
Refresh must read server state, not just redraw the tree.

Record each result as **PASS**, **FAIL**, **BLOCKED**, or **NOT EXECUTED**.
Separate real Host API assertions from visual/menu/mouse checks: automated API
success does not certify rendering or actual context-menu visibility.

## Native frame and toolbar checks (0.3.0)

- Open a saved pending hunk. Check its whole-line frame and tinted region start/end
  match Core locator bounds, including single-line deletion anchors.
- Click the native editor toolbar Accept/Revert icons with the cursor inside the
  hunk. Verify only that hunk changes; terminal action guards still apply.
- For overlapping targets from multiple sets, verify the explicit hunk picker.
- Check Tree row inline icons appear only for Pending supported targets.
- Dirty buffers must clear frames and actionable toolbar context immediately.
- A disconnected Status Bar must expose Reconnect; coverage text stays visible.

A CodeLens link is not a styled button. Do not certify Copilot's in-block floating
button appearance from this native toolbar implementation.

## Review presentation checks (0.4.0)

- One set: File → Hunk. Multiple sets: Changes N → File → Hunk. No raw UUID in
  default labels; every hunk remains under its own file/set after refresh.
- File descriptions are short. Pending hunks have counts and a patch excerpt,
  without Pending text or a dot. Empty-file presence falls back to `Empty file`.
- Collapse a file, review another file, and Refresh. Its collapsed state remains.
  Accept/Revert must preserve TreeItem identities and never merge sets.
- Pending CodeLens is `✓ Accept Change | ↶ Revert Change`. Accepted is read-only;
  Reverted has a file-header summary without pretending removed content has a
  live position. Conflict keeps Open Diff and has no Force Revert.
- Coverage warning appears once above the tree. Hover the native title info icon
  for the untracked-writes explanation; no custom HTML is used.
- Compare actual before/after screenshots independently of API assertions.
