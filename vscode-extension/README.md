# Codex Changes Review

Independent VS Code Extension MVP for this fork's Git-independent ChangeSet
review. Uses a native CHANGES tree, native diff editors and Core-located
Accept/Revert CodeLens beside each pending hunk. Core owns matching, rollback,
conflict detection and decisions; the extension presents its snapshots.

## Installed extension: normal VS Code use

Install the VSIX in your ordinary VS Code profile. Keep your existing VS Code,
GitHub and Codex login state. Trusted local workspaces activate Changes on startup.

For the official Codex IDE, perform this setup once:

Build the fork's runtime components together before starting the shared server:

```sh
cd ../codex-rs
cargo build -p codex-cli -p codex-code-mode-host -p codex-exec-server
```

Use `target/debug/codex` for the server below, keeping `codex-code-mode-host` and
`exec-server` beside it. The official IDE's Code Mode tools need the host binary;
a successful connection alone does not verify that tools can execute.

1. Start the forked CLI's shared server with your normal Codex configuration and
   credentials: `codex app-server --listen ws://127.0.0.1:4510` (use the fork's
   executable, not an older system CLI).
2. In the Command Palette, run **Codex Changes: Connect Codex IDE to Shared Server**.
   Enter that URL and select the forked `codex` CLI executable.
3. Finish existing chats, then reload the VS Code window once. The running local
   producer cannot transfer its live Core session into another process.

The connection is stored in the existing user profile. Subsequent trusted
workspaces connect automatically. Changes reads the endpoint saved for the IDE;
obsolete workspace stdio/URL settings cannot split the producer and reviewer.
A disconnected shared connection retries automatically without reloading the
window or creating a private Core fallback. The manual server must be running;
this release does not install a daemon or an OS service.

Open a Codex chat for the current workspace. An existing chat remains associated
with its original thread/cwd, even when a different workspace is opened. Use
**Codex Changes: Show Connection and Workspace** to inspect the current target.
The setup retains authentication, UI preferences and the system `codex` command.
Non-server IDE helper commands still use the original bundled/custom executable.
**Restore Original Codex IDE Connection** restores the previous executable choice;
finish current chats before applying that change once.

Coverage remains `applyPatchOnly`, with `sessionMemory` storage. Ordinary shell,
MCP and background writes do not generate tracked ChangeSets. Session snapshots
are not persisted across shared server restarts.

The F5 workspaces and isolated-profile launch scripts below are developer/test
fixtures. They are not required for using the installed extension.

## Layout and protocol

```text
codex/                           # published GitHub checkout
├── codex-rs/                    # authoritative Core / App Server
│   └── app-server-protocol/schema/typescript/
└── vscode-extension/            # independent npm project
```

The existing local development layout `codex-ide/{codex,vscode-extension}` is
also supported without moving either directory. In that layout, use
`../codex/codex-rs` in place of `../codex-rs` in the commands below.

`src/appServer/protocol.ts` imports the fork's generated schema through a
TypeScript path alias that resolves either layout. All imports are type-only,
erased from the bundle; installed extensions need the forked executable, not
source files. Test scripts resolve the same two layouts. No wire models are
copied or handwritten. The existing
TypeScript SDK runs `codex exec`, so its transport cannot be reused for this API.

## Build and debug

Requires Node 20+ and VS Code 1.95+. From `vscode-extension/`:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Open `codex-changes.code-workspace` in VS Code and press F5. This launches an
Extension Development Host. Open the workspace being reviewed in that host;
the development workspace itself is only the extension's source. Use
`npm run watch` for rebuilding during development, then restart the debug session
to load changes. The Activity Bar has a **Codex Changes** container and **CHANGES**
view. The status bar and **Show App Server Log** command show connection state.
Workspace trust is required before spawning a process or connecting.

Build the forked standalone server when needed:

```sh
cd ../codex-rs
cargo build -p codex-app-server --bin codex-app-server
```

### Shared server: the practical review workflow

ChangeSets belong to one App Server's memory. The producer that starts the Codex
turn and this review extension **must connect to the same server process**.
Starting a separate `codex exec`, TUI or unrelated IDE process does not populate
this server's ChangeSets. This extension does not initiate inference turns.

Start the fork's shared server:

```sh
../codex-rs/target/debug/codex-app-server --listen ws://127.0.0.1:4500
```

Configure the reviewed workspace in VS Code:

```json
{
  "codexChanges.connectionMode": "websocket",
  "codexChanges.websocketUrl": "ws://127.0.0.1:4500"
}
```

Run the fork's normal CLI/TUI as the producer:

```sh
cd /path/to/reviewed/project
/absolute/path/to/codex/codex-rs/target/debug/codex --remote ws://127.0.0.1:4500
# Alternatively set CODEX_APP_SERVER_URL for this CLI invocation.
```

The existing TUI connects to the shared server and drives its thread/turn; it
does not create an embedded Core session. Local CLI launch remains the default.
After a tracked `apply_patch` turn finishes or is interrupted, the server sends
`changeSet/created`, and files/hunks appear automatically.

On connection or Refresh, the extension uses `thread/loaded/list`,
`thread/read` metadata, `thread/resume` without overrides to join loaded workspace
threads, and `changeSet/list` to recover all finalized snapshots retained in
those live sessions, independently of conversation history mode. It also handles
`thread/started` and canonical thread cwd to discover later CLI threads without
copying IDs. Changing workspace folders reconnects and clears the previous state.
It does not cold-resume arbitrary persisted history. A loaded thread disappearing
between discovery and resume remains a server lifecycle race.

### Owned stdio process

Default configuration starts `codex app-server` using newline-delimited JSON on
stdin/stdout. To use the fork's standalone executable:

```json
{
  "codexChanges.connectionMode": "stdio",
  "codexChanges.serverCommand": "/absolute/path/to/codex/codex-rs/target/debug/codex-app-server",
  "codexChanges.serverArgs": []
}
```

`serverCommand` is an executable path, not a shell command, and `~` is not
expanded. `serverArgs` are passed directly without a shell. Stdio is useful for
connection diagnostics and the automated smoke fixture; a private stdio child
cannot observe another producer process. The extension's restart command stops
its owned child, or disconnects/reconnects a shared server without terminating it.

## Architecture and changed files

```text
AppServerProcess                  start/stop/restart, streams, stderr, exit
        ↓
StdioTransport / WebSocketTransport
        ↓
AppServerClient                   handshake, IDs, timeout, RPC errors, events
        ↓
ChangeSetStore                    authoritative snapshots, revision, references
        ↓
ChangeTreeProvider + CodeLens     stable ChangeSet/File/Hunk identities
        ↓
Commands → NativeDiff             locate → vscode.diff → reveal live range
```

The extension presents server-owned snapshots; rollback and matching stay in Core:

| Files                                                                                | Responsibility                                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `package.json`, `package-lock.json`, `tsconfig.json`, `build.mjs`                    | Manifest, independent reproducible install, type check and bundled build |
| `codex-changes.code-workspace`, `resources/changes.svg`                              | F5 launch/task and Activity Bar container icon                           |
| `.gitignore`, `.vscodeignore`, `.prettierignore`, `LICENSE`                          | Build/package hygiene and license                                        |
| `src/extension.ts`                                                                   | Activation, trusted workspace connection, watcher, disposal, reconnect   |
| `src/appServer/{process,transport,client,protocol,errors}.ts`                        | Separate lifecycle/framing/RPC and generated protocol adapter            |
| `src/changes/{models,changeSetStore,changeTreeItems,changeTreeProvider,commands}.ts` | Stable IDs, snapshots, state presentation and review actions             |
| `src/diff/{identity,range,diffContentProvider,openDiff}.ts`                          | Unique virtual documents, range conversion and native diff               |
| `src/review/{inlineReview,hunkCodeLensProvider}.ts`                                  | Core-located inline actions and native CodeLens adapter                  |
| `src/status/statusBar.ts`                                                            | Connecting / Ready / Disconnected                                        |
| `test/{fixtures,client,store,range,tree}.ts` / `*.test.ts`                           | Unit fixtures and tests                                                  |
| `scripts/smoke.ts`                                                                   | Real fork App Server with a local mock Responses provider                |
| `README.md`, `MANUAL-ACCEPTANCE.md`                                                  | Setup, limitations, protocol and UI acceptance                           |

The tree hides a single ChangeSet root; multiple known ChangeSets retain roots.
Tree IDs contain thread, turn, set, file and hunk IDs, never file paths or indices.
Hunk rows show `+N −M` with a short changed-line excerpt from the Core patch.
Pending has no dot or repeated state text; terminal states use ThemeIcons.
File descriptions are `N changes`, `Added`, `Deleted`, or an exceptional state.
Protocol IDs and progress stay in tooltips. Bulk actions remain available in partially conflicted files if
there are still Pending hunks. Single hunk review is available only for Pending.

## Commands and protocol usage

Every command has the `codexChanges.` prefix:

| Commands                   | RPC / behavior                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `openHunk`                 | `changeSet/hunk/locate`, then native file diff and live reveal                                                      |
| `acceptHunk`, `revertHunk` | `changeSet/hunk/accept`, `changeSet/hunk/revert`                                                                    |
| `openFile`                 | Baseline vs current file diff                                                                                       |
| `acceptFile`, `revertFile` | `changeSet/file/accept`, `changeSet/file/revert`                                                                    |
| `acceptAll`, `revertAll`   | `changeSet/accept`, `changeSet/revert`; explicit Tree target, or choose a pending ChangeSet when multiple are known |
| `refresh`                  | `changeSet/read` for known sets, followed by loaded-thread discovery                                                |
| `restart`                  | Restart owned process or reconnect shared WebSocket                                                                 |
| `showOutput`               | Show lifecycle/stderr/protocol diagnostics                                                                          |

`initialize` opts into experimental APIs and is followed by `initialized`.
Notifications `changeSet/created` and `changeSet/updated` replace snapshots;
`turn/completed` triggers a fallback read. Requests have timeouts and pending-ID
tracking; malformed frames and transport death reject pending work and disconnect.
Late responses with expired IDs are ignored. No destructive operations retry
automatically. Timeout means the server may have completed the operation; Refresh
before retrying. The server routes thread interactions, including tool approvals,
only to the connected producer. It validates callback responses against that
recipient and excludes observers from pending-request replay. The review client
also defensively sends neither approval nor rejection to interactive requests.

## Diff semantics

Left: immutable `beforeContent`, exposed by a read-only `codex-change:` provider.
Right: the real current `file:` document when present, including VS Code's normal
editing behavior. An absent right file uses a virtual current document, initially
empty, refreshed by file events; restored files therefore appear even in an
already open virtual diff. The title identifies an absent file. Added files use
an empty baseline. Deleted files use the stored baseline and empty current side
while absent; a restored file is compared against its actual current content.
Unsupported baselines or non-local paths show a clear information message.

Each virtual URI encodes thread/turn/set/file/side in its query through VS Code's
URI API. All hunks in one file share the same baseline URI. The extension never
reconstructs a baseline from Git or uses the turn-final `afterContent` as the
current filesystem image.

Clicking any hunk calls Core's read-only locator, including Accepted and Reverted
hunks. `located/content` converts one-based start to zero-based and uses an
exclusive end, bounded by the document's last text column. `deletionAnchor` is
a zero-length cursor anchor clamped to a valid BOF/middle/EOF line.
`filePresence` opens the diff without forcing selection. `notPresent/reverted`
shows “This change has already been reverted.” without revealing an old location.
Conflict opens the best available diff and warns; Unsupported informs. Location
hints appear in the tree separately from authoritative server review decisions,
and clear on a new snapshot or file event. `oldStart/newStart` never guide live
navigation.

Native UI follows the official [Tree View API](https://code.visualstudio.com/api/extension-guides/tree-view)
and [`vscode.diff` command](https://code.visualstudio.com/api/references/commands).

## State synchronization

Full snapshots are stored per stable identity. Only a strictly newer `revision`
replaces a known snapshot; identical or older revisions emit no tree update.
Both notification-first and RPC-first orderings therefore converge. Each review
response's per-hunk `results` provides Conflict/Unsupported explanations, while
the complete server snapshot supplies all actual decisions, including partial
success and unchanged terminal states. A stale response cannot regress the UI.
Review clicks within a set are serialized at the command layer. In-flight reads
and reviews from a previous connection are ignored after the store generation
changes. The tree does not maintain a separate business state.

`workspaceState` saves only the last thread/turn/set IDs. Reload tries
`changeSet/read`; null/missing data clears the reference. Transport errors retain
the reference for retry. Disconnect clears visible snapshots; reconnect discovers
loaded sets again. Only snapshots with a local file in the open workspace are
shown, and discovered threads must have a cwd in that workspace.

## Tests

`npm test` runs 51 Node tests: initialization and out-of-order IDs; RPC errors;
subscriptions; process death; malformed messages; timeouts/late replies;
producer approval isolation; split UTF-8 and line framing; 1→0 and 73→72 range
conversion; EOF content; BOF/middle/EOF/empty deletion anchors; filePresence;
created/updated/RPC snapshots; duplicate/older revisions; both partial rollback
race orders; conflicts; read-only location hints; restart generations; stale
references; Refresh/discovery/subscription; unsupported files; state labels/icons;
context actions; and escaped stable virtual identities.

`npm run smoke` uses the fork's debug `codex-app-server` binary. Set
`CODEX_APP_SERVER_BIN` to an alternate **debug standalone** binary if needed;
the fixture disables plugin startup through its debug-only test flag. It creates
a canonical temporary home/workspace and local HTTP mock model, calls a real
tracked patch turn, then exercises read, locate, hunk/file/all review endpoints
over stdio and WebSocket. It checks two hunks per modified file, shift after
partial rollback, a 20-line user insertion, Accepted hunk locate, deletionAnchor,
empty added filePresence, deleted-file absence, partial conflict/user-content
preservation, late-client recovery and subscribed peer notifications. No real
model credentials are required. Temporary files/processes are cleaned up.

The additional tests cover stable inline references, live locations, stale action
rejection, dirty buffers, cancelled/late locator replies, multiple retained turns,
Tree-selected bulk operations and picker races.

```sh
npm run host:acceptance
npm run host:lifecycle
npm run host:shared-cli
```

`host:shared-cli` runs the real Rust interactive CLI in a PTY, the shared server,
and two isolated real VS Code reviewers with a deterministic local Responses SSE
model. It verifies two-hunk Accept/Revert and the filesystem, a second turn in the
same thread, producer-only approval, two workspaces and live folder switching,
Ctrl+C, disconnect/resume ownership, server survival, explicit connection failure,
and the local TUI backend. Each run writes its evidence under
`acceptance-results/shared-cli/`.
It uses temporary homes, workspaces and VS Code profiles; no installed Codex or
user settings are replaced. The existing TUI's ephemeral title-generation threads
also run in the same server and are distinguished from the two main producer threads.

`host:acceptance` launches an isolated real VS Code Extension Host and forked
shared App Server with mock model responses. It invokes actual native CodeLens
and review commands, opens native diffs, and checks saved disk results. The fixture
includes two consecutive tracked turns, subscribed peer decisions, oversized
unsupported files, all deletion anchor boundaries and a real producer-owned tool
approval request. Its disposable test profile disables workspace trust and other
extensions; the normal user's profile is unchanged.

`host:lifecycle` uses a separate temporary driver extension in an ordinary
Development Host, avoiding VS Code's extension-test initialization/restart
interlock. It invokes the built-in Restart Extension Host command and checks
actual Host/owned-child PID replacement, shared revision recovery and stale target
rejection. A local fixture remains outside the Host throughout the test.

Native editor rendering, actual menu visibility and mouse interactions require the explicit
[manual checklist](MANUAL-ACCEPTANCE.md). API assertions are recorded separately
from those visual checks.

## Inline native review

Open a current file or a hunk's native diff. Pending hunks show **✓ Accept Change** and
**↶ Revert Change** at the current position returned by `changeSet/hunk/locate`. File
headers retain **Accept File / Revert File**, with no protocol or Pending label.
Multiple sets affecting a file retain separate targets; each command argument
contains thread/turn/set/file/hunk IDs. The baseline side has no live actions.
Empty-file presence and an absent deleted file have explicit file-presence tooltips.
An unavailable position uses a neutral header with no hunk
review buttons. Accepted state is read-only; reverted actions disappear and a
read-only Reverted summary appears at the file header, since removed content has
no live position. Conflict
keeps **Open Diff**. Unsupported files expose only their explanation.

Tree, inline review and native diff use the same `ChangeSetStore`. New snapshots,
editor edits, saves, disk events and reconnect invalidate CodeLens. Revision,
connection generation, document version and cancellation guards discard late
positions. Commands re-read the selected stable target and reject terminal or
expired actions before a mutation RPC. Bulk title actions honor Tree selection;
without selection, multiple known sets require a picker, never an implicit latest
set.

Dirty target documents show exactly:
`Save or discard editor changes before reviewing this Codex change.`
All review levels are blocked and nothing is automatically saved. Diff opening
remains available without a disk-derived selection.

The configuration `codexChanges.inlineReview` defaults to true. VS Code's
`editor.codeLens` and `diffEditor.codeLens` must also be enabled; the extension
contributes a true default for diff CodeLens while respecting explicit overrides.
This uses the native [CodeLens API](https://code.visualstudio.com/api/references/vscode-api#CodeLens).

## Known limitations

- `sessionMemory`: server restart, unload or thread-history replacement can lose
  the snapshot and baseline. Client metadata is only a reconnect hint.
- `applyPatchOnly`: arbitrary shell writes, MCP writes and background processes
  are not covered. The view always displays this coverage warning.
- Locator/revert use saved disk content. Unsaved buffers are excluded by Core.
  Native diff may display unsaved text; in that case the extension warns and
  suppresses disk-derived reveal. Review operations require selected files to
  have no dirty open documents. A concurrent edit after that check can still race.
- Stdio-owned Extension Host reload restarts its child and loses its ChangeSets.
  Shared WebSocket reload recovers finalized snapshots from each matching loaded
  thread via `changeSet/list`; server restart still loses review state.
- WebSocket supports unauthenticated loopback `ws://` only in this MVP; no remote,
  bearer-token, TLS or account/login UI. Installed shared connections retry
  automatically; the shared server itself must be started manually.
- Unsupported Core inputs remain unsupported: binary/non-UTF-8, oversized files,
  renames, remote environments, symlinks, non-exact/interleaved patch deltas.
  The extension does not bypass or repair these decisions.
- Accept is metadata-only. Accepted/Reverted/Conflict are terminal; no reopen or
  force rollback. File/All operations review Pending hunks only.
- Live locator results are point-in-time and can become stale immediately after
  an external write. Core matches again when reverting; its existing lack of
  cross-process filesystem CAS is unchanged.

## Review presentation

Pending hunk regions now have Core-located native border/background decorations.
The editor toolbar and Tree rows expose actual Accept/Revert icon buttons. With
the cursor in a pending located region, toolbar review targets that hunk; ambiguous
overlapping targets, or a cursor outside a region, require explicit selection.
CodeLens itself remains a text link; stable extension APIs cannot make it a
Copilot-style floating button container.

Multiple sets use numbered `Changes 1 / Changes 2` groups with file counts;
a single set exposes File → Hunk directly. Group numbers are display names,
not chronological claims or RPC targets. Stable full references remain the
native TreeItem IDs and command arguments. Pending hunk rows have no status
icon or text; their description is a trimmed, bounded patch excerpt. Review
progress and IDs are in tooltips. CodeLens is now just the compact action pair
or a read-only status. Coverage is shown once above the tree; its full explanation
is available on the native title-bar info button and Status Bar tooltip.
