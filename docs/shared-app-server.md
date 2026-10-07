# Shared CLI / IDE producers and Changes reviewer

## Investigation (before implementation)

The interactive CLI already supports `--remote`: `cli/src/main.rs` resolves a
`RemoteAppServerEndpoint` and passes it to `tui::run_main`. Local launch selects
an embedded app-server (or the existing managed daemon). The remote branch of
`tui/src/lib.rs::start_app_server` connects through `app_server_connection` and
returns before constructing the embedded server. An explicit remote failure is
returned, never used as a reason to fall back to embedded mode.

`app-server-client/src/remote.rs` is the existing Rust client: WebSocket/Unix
transport, initialize/initialized, request correlation, streaming notifications,
server requests, and connection shutdown. Remote shutdown closes the socket; it
does not shut down the shared server. No new UI or transport is required.

`tui/src/app_server_session.rs` creates/resumes/forks threads via v2 and submits
`turn/start`/`turn/steer`/`turn/interrupt`. Thread start passes model, provider,
service tier, cwd, permission selection, approval policy/reviewer and explicit
config overrides. Remote config/account/model queries use the server; credentials
and provider authentication belong to the server host. Remote resume preserves
server permission settings unless explicitly changed through supported UI flows.
`app/app_server_events.rs`, `app/app_server_requests.rs` and
`app_server_approval_conversions.rs` translate typed assistant/reasoning deltas,
command output, command/file/MCP items, completion and approval interactions into
the existing chat widget and bottom pane. Core does not run in the remote TUI.

Server `request_processors/thread_processor.rs` creates the authoritative
`CodexThread` using ThreadManager. `turn_processor.rs` submits to that same
thread. The thread listener in `thread_lifecycle.rs` consumes Core events and
emits v2 notifications. apply_patch and ChangeSet storage/review live in that
Core session. `change_sets.rs` reviews the retained session ChangeSet and sends
updates to thread subscribers.

Multiple subscribers already exist in ThreadStateManager. Warm `thread/resume`
atomically joins the listener without creating another Core session. However,
ThreadScopedOutgoingMessageSender sends interactive requests to every subscriber,
and ordinary callback responses previously had no connection ownership check.
Warm resume also replays those requests. Thus an observer could resolve or abort
the producer's approval. This needs server-side routing and response validation.

Thread creation emits global `thread/started`. The extension must explicitly
warm-resume matching new threads to join their listener. It previously only discovered
loaded threads at startup/refresh, using `thread/read`, warm `thread/resume`,
`thread/turns/list` and `changeSet/read`. It must process subsequent thread starts
and filter by canonical thread cwd, not by a changed file falling within the
workspace (a thread may edit outside its own workspace).

Loaded paginated threads do not always implement `thread/turns/list` in this
fork's backing store, and ephemeral threads have no persisted conversation
history. The minimal `changeSet/list {threadId}` API reads finalized snapshots
already retained by Core. It provides reconnect/workspace-switch recovery without
adding conversation discovery or ChangeSet persistence. Metadata-only warm joins
also use the loaded thread directly before the first rollout exists.

Decision: A, CLI as App Server client, reusing the existing remote TUI backend.
B would duplicate an already available boundary. No diff forwarding, filesystem
change detection or Git polling is involved.

## Usage

Build the forked runtime bundle, then run:

```sh
cd codex-rs
cargo build -p codex-cli -p codex-code-mode-host -p codex-exec-server
```

Keep `codex`, `codex-code-mode-host` and `exec-server` together in the build's
binary directory. Building only `codex` is sufficient for protocol connections,
but not for IDE tool execution with Code Mode enabled. A connected reviewer can
report Ready while tool execution fails because the host executable is missing;
verify an actual `apply_patch` turn before treating setup as complete.

For this fork, `[workspace.package].version` is the compatibility version for
unpackaged Cargo builds (currently `0.162.0-alpha.2`, matching the installed IDE
runtime and Code Mode host). `codex-build-info` embeds that version as the fallback
when there is no valid `codex-package.json`; packaged releases still use their
manifest version. `codex --version` and the App Server initialize user agent
already read the compiled Cargo version; the fallback keeps other runtime build
information consistent with them after later local rebuilds. Supply
`STABLE_GIT_COMMIT=$(git rev-parse HEAD)` when building to retain commit provenance.
After a rebuild, restart the shared App Server and reload VS Code so both clients
use the new runtime. Server restart discards session-memory ChangeSets.

For this macOS development installation, the V8 prebuilt download for a source
host build returned 404. The existing official IDE package's
`codex-code-mode-host` (0.162.0-alpha.2) was copied beside the fork CLI. Its
negotiated Code Mode protocol and real `exec` → `apply_patch` execution were
verified against the running shared server. This supplies only the JavaScript
runtime component: Core, tools, approvals and ChangeSets remain owned by the
forked shared server. No second local Core is started. Recheck compatibility if
the fork's host protocol changes; production packages must include a compatible
host rather than depend on a separately installed extension's path.

```sh
codex app-server --listen ws://127.0.0.1:4500
cd /path/to/project
codex --remote ws://127.0.0.1:4500
# Alternatively: CODEX_APP_SERVER_URL=ws://127.0.0.1:4500 codex
# Resume the same server-owned thread:
codex --remote ws://127.0.0.1:4500 resume THREAD_ID
```

Set VS Code `codexChanges.connectionMode` to `websocket` and
`codexChanges.websocketUrl` to that same URL. The extension discovers matching
loaded and newly created threads; no IDs need copying. For nonlocal servers,
use `--cd /path/on/server`. Loopback endpoints default to the terminal's canonical
cwd. Authentication belongs to the server; transport bearer tokens use the
existing `--remote-auth-token-env` option.

Local launch behavior remains available and unchanged when no endpoint is given.
Explicit shared connection failure is fatal. CLI exit disconnects its client.
The manual server process remains alive; no new daemon installation is added.
Use the fork's project binary (`codex-rs/target/debug/codex`) for these commands;
this work does not replace the system-installed `codex` or alter the user's config.

## Official VS Code Codex IDE producer (opt-in)

The installed official `openai.chatgpt` extension launches a CLI executable with
`-c features.code_mode_host=true app-server --analytics-default-enabled`, then
exchanges JSONL on its stdio. Its `chatgpt.cliExecutable` development setting lets
an opt-in launcher replace that transport process. It does not expose a shared
WebSocket URL setting in the version inspected here.

`codex --remote ws://127.0.0.1:4500 app-server proxy` now transparently bridges
stdio JSONL to the shared WebSocket. The IDE sends its own initialize, thread/turn
requests and approval responses unchanged. The proxy creates no Core session,
does not initialize as a second client and never sends a server shutdown RPC.
EOF/termination only disconnects the IDE. Connection failure is explicit; there
is no local fallback. Existing `app-server proxy --sock` behavior remains intact.

`scripts/codex-shared-ide` adapts the official IDE startup invocation to that proxy;
ordinary utility invocations such as `--version` still use the project executable.
Server startup `-c` overrides are not applied by a transport proxy. Configure model,
authentication, sandbox and features on the shared server itself; thread-specific
settings sent by the IDE still travel unchanged through JSON-RPC.

Install Changes 0.5 in the ordinary VS Code profile. Use **Codex Changes: Connect
Codex IDE to Shared Server** once to select the running loopback server and the
forked CLI. The extension saves a self-contained wrapper and connection record in
its persistent global storage, then updates only `chatgpt.cliExecutable` through
VS Code's configuration API. It retains the original executable choice for
restoring later and delegates non-server utilities to that original executable.

Finish current chats and reload the window once: a live local producer's Core
session cannot be moved into another process. No new VS Code data directory,
credential copy, repeated login or per-workspace F5 launch is required. Subsequent
trusted local workspaces activate and connect automatically. The reviewer reads
its endpoint from the configured IDE registration, so old workspace stdio/URL
settings cannot split the two clients. Connection loss retries with capped
backoff; it neither reloads the window nor falls back to local Core. Corrupt
explicit shared registration stays disconnected instead of starting a private
session. The setup never automatically reloads or terminates a running chat.

Use a new Codex chat for the opened project. An existing chat retains its original
thread/cwd when workspaces change. **Show Connection and Workspace** reports the
review endpoint and current roots. Approvals belong to each thread's producer;
Changes remains an observer. Separate conversations are not merged.

The optional `prepareSharedIde.mjs` profile launcher remains a test fixture. It
isolates login state and must not be offered as the ordinary installed workflow.
`scripts/configureInstalledIde.ts` is a one-time local setup helper for the normal
profile: it patches only the CLI setting, preserves JSONC comments and unrelated
settings, backs up the original settings privately and refuses concurrent edits.
It does not launch a window or copy credentials.

The current setup supports local macOS/Linux. The server is still manually
started with the user's normal Codex home/config; no daemon/service installation
is added. Closing a client leaves that server running. Coverage and storage
limits remain `applyPatchOnly` and `sessionMemory`.

## Ownership and limits

The thread creator and then the client driving a turn own interactive server
requests. Subscribing/resuming a loaded thread never transfers ownership. Pending
requests capture their recipient so later ownership changes cannot authorize a
response to an old request. Observers receive item/turn/ChangeSet status updates
but cannot resolve an approval, even with a guessed request ID. Producer loss
cancels its pending interactions rather than delegating them to a reviewer.
Another client cannot claim a thread while its producer is connected. After that
producer disconnects, the next turn driver can claim it, including a resumed CLI.

ChangeSet coverage remains `applyPatchOnly`, storage `sessionMemory`. This work
does not add shell/MCP write tracking, ChangeSet persistence, Git, conversation
UI or memory. Server unload/restart still discards retained review state.

## Verified acceptance

`npm run host:shared-cli` (from `vscode-extension/`) passed with the real Rust CLI/TUI in
a controlling PTY, the real shared WebSocket App Server, and two actual VS Code
Extension Hosts. Model inference used a deterministic local Responses SSE server.
Tools, patch execution, Core ChangeSets, native diff/review commands and filesystem
mutations were real. Temporary homes/workspaces/profiles isolate the test.

Verified CLI output/tool execution and two hunks in `src/a.rs`; native VS Code
Accept one/Revert the other and the resulting filesystem; matching CLI/reviewer
thread identity; a second `src/b.rs` turn in that thread; actual CLI approval and
continued execution while the observer received zero interactive requests; two
concurrent CLI workspaces with reviewer isolation and live workspace switching;
Ctrl+C; no CLI child server; CLI exit preserving the server; a new CLI resuming
the same thread and claiming production; clear connection failure with no local
fallback; and existing local TUI operation. The normal TUI creates ephemeral title
helpers, which also execute on the shared server, not in hidden local sessions.

Each invocation writes fresh evidence and CLI/notification/model transcripts
under `vscode-extension/acceptance-results/shared-cli/`. Rust checks cover request routing,
observer response/replay rejection and disconnect races (36 tests), ChangeSet
operations/listing (12 integration tests), and fresh/ephemeral observer joining.
The extension's 51 Node tests, typecheck and build pass.
