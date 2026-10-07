import * as vscode from "vscode";
import { realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { AppServerProcess } from "./appServer/process";
import {
  StdioTransport,
  WebSocketTransport,
  UnavailableTransport,
} from "./appServer/transport";
import { AppServerClient } from "./appServer/client";
import { ChangeSetStore } from "./changes/changeSetStore";
import { ChangeTreeProvider } from "./changes/changeTreeProvider";
import { isReference, hasPending } from "./changes/models";
import { registerCommands, reportError } from "./changes/commands";
import { DiffContentProvider, DIFF_SCHEME } from "./diff/diffContentProvider";
import { NativeDiff } from "./diff/openDiff";
import { ConnectionStatus } from "./status/statusBar";
import { InlineReview } from "./review/inlineReview";
import { HunkDecorations } from "./review/hunkDecorations";
import { HunkCodeLensProvider } from "./review/hunkCodeLensProvider";
import { readRegistration } from "./sharedIde/registration";
import { registerSharedIdeSetup } from "./sharedIde/setup";
import { SharedReconnect } from "./appServer/reconnect";

const REFERENCE_KEY = "codexChanges.lastReference";
let shutdown: (() => Promise<void>) | undefined;
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (!vscode.workspace.isTrusted) return;
  const output = vscode.window.createOutputChannel("Codex Changes Review");
  const coverageExplanation =
    "Changes made through untracked shell, MCP, hook or background writes may not appear here.";
  context.subscriptions.push(
    vscode.commands.registerCommand("codexChanges.showCoverage", () =>
      vscode.window.showInformationMessage(coverageExplanation),
    ),
  );
  const log = (message: string) => output.appendLine(message);
  context.subscriptions.push(
    ...registerSharedIdeSetup(context, log, () => restart()),
  );
  const contents = new DiffContentProvider();
  const status = new ConnectionStatus();
  const belongs = (pathOrUri: string) => {
    const uri = /^[a-zA-Z][\w+.-]*:\/\//.test(pathOrUri)
      ? vscode.Uri.parse(pathOrUri)
      : vscode.Uri.file(pathOrUri);
    return (
      uri.scheme === "file" &&
      !uri.authority &&
      !!vscode.workspace.workspaceFolders?.some((folder) => {
        if (folder.uri.scheme !== "file") return false;
        const canonical = (path: string) => {
          try {
            return realpathSync.native(path);
          } catch {
            return resolve(path);
          }
        };
        const fromRoot = relative(
          canonical(folder.uri.fsPath),
          canonical(uri.fsPath),
        );
        return (
          fromRoot === "" ||
          (!isAbsolute(fromRoot) &&
            fromRoot !== ".." &&
            !fromRoot.startsWith(`..${sep}`))
        );
      })
    );
  };
  let client: AppServerClient | undefined;
  let store: ChangeSetStore | undefined;
  let provider: ChangeTreeProvider | undefined;
  let lenses: HunkCodeLensProvider | undefined;
  let decorations: HunkDecorations | undefined;
  let lensRegistration: vscode.Disposable | undefined;
  let view: vscode.TreeView<import("./changes/models").ReviewNode> | undefined;
  let commands: vscode.Disposable[] = [];
  let disposed = false;
  let lifecycle: Promise<void> = Promise.resolve();
  let sharedEndpoint: string | undefined;
  let sharedIde = false;
  let setupError: Error | undefined;
  const reconnect = new SharedReconnect(async () => {
    log("Reconnecting to the shared server…");
    await restart(true);
  });
  const metadata = {
    get: () => {
      const value = context.workspaceState.get(REFERENCE_KEY);
      return isReference(value) ? value : undefined;
    },
    save: async (
      value: import("./changes/models").ChangeSetRef | undefined,
    ) => {
      await context.workspaceState.update(REFERENCE_KEY, value);
    },
  };
  const update = () => {
    if (!client || !store || !view) return;
    const state = client.connectionState;
    status.update(state);
    view.description = sharedIde ? "Shared Codex IDE" : "";
    view.message = [
      setupError
        ? "Shared IDE configuration unavailable — use Connect Codex IDE to Shared Server"
        : state === "Ready"
          ? store.all.length
            ? ""
            : "No tracked changes for this workspace"
          : state === "Disconnected"
            ? sharedEndpoint
              ? "Shared server disconnected — reconnecting automatically…"
              : "Disconnected — use Reconnect ↻"
            : "Connecting…",
      // The MVP's coverage limitation also remains explicit before the first snapshot.
      "⚠ Reviewing tracked Codex edits only",
    ]
      .filter(Boolean)
      .join("\n");
    void vscode.commands.executeCommand(
      "setContext",
      "codexChanges.ready",
      state === "Ready",
    );
    void vscode.commands.executeCommand(
      "setContext",
      "codexChanges.hasPending",
      view.selection[0]
        ? !!store.get(view.selection[0].ref) &&
            hasPending(store.get(view.selection[0].ref)!)
        : store.pendingCount > 0,
    );
    contents.refreshCurrent();
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codexChanges.connectionInfo",
      async (options?: { silent?: boolean }) => {
        const info = {
          state: client?.connectionState ?? "Disconnected",
          sharedIdeConfigured: sharedIde,
          endpoint: sharedEndpoint,
          workspaceRoots:
            vscode.workspace.workspaceFolders?.map(
              (folder) => folder.uri.fsPath,
            ) ?? [],
          changeSets:
            store?.all.map((set) => ({
              threadId: set.threadId,
              turnId: set.turnId,
              id: set.id,
            })) ?? [],
        };
        if (!options?.silent) {
          log(JSON.stringify(info, null, 2));
          output.show();
        }
        return info;
      },
    ),
  );
  const teardown = async () => {
    commands.forEach((command) => command.dispose());
    commands = [];
    const previousClient = client;
    previousClient?.removeAllListeners("state");
    store?.dispose();
    provider?.dispose();
    decorations?.dispose();
    decorations = undefined;
    lensRegistration?.dispose();
    lenses?.dispose();
    view?.dispose();
    store = undefined;
    provider = undefined;
    lenses = undefined;
    lensRegistration = undefined;
    view = undefined;
    client = undefined;
    await previousClient?.stop();
  };
  const connect = async () => {
    reconnect.cancel();
    await teardown();
    if (disposed) return;
    const config = vscode.workspace.getConfiguration("codexChanges");
    setupError = undefined;
    const registration = await readRegistration(
      vscode.workspace.getConfiguration("chatgpt").get<string>("cliExecutable"),
    ).catch((error) => {
      setupError = error instanceof Error ? error : new Error(String(error));
      return undefined;
    });
    sharedIde = !!registration;
    sharedEndpoint =
      registration?.endpoint ??
      (config.get("connectionMode") === "websocket"
        ? config.get<string>("websocketUrl")
        : undefined);
    log(
      `Review workspace: ${vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).join(", ") ?? "none"}`,
    );
    if (sharedEndpoint)
      log(
        `Shared server: ${sharedEndpoint}${sharedIde ? " (same connection as Codex IDE; workspace review overrides do not apply)" : ""}`,
      );
    const transport = setupError
      ? new UnavailableTransport(setupError)
      : sharedEndpoint
        ? new WebSocketTransport(sharedEndpoint)
        : new StdioTransport(
            new AppServerProcess(
              {
                command: config.get<string>("serverCommand")!,
                args: config.get<string[]>("serverArgs")!,
                cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
              },
              log,
            ),
          );
    const connectedClient = (client = new AppServerClient(
      transport,
      log,
      config.get<number>("requestTimeoutMs"),
    ));
    const connectedStore = (store = new ChangeSetStore(
      connectedClient,
      metadata,
      belongs,
      log,
    ));
    provider = new ChangeTreeProvider(connectedStore);
    view = vscode.window.createTreeView("codexChanges.tree", {
      treeDataProvider: provider,
    });
    const connectedView = view;
    lenses = new HunkCodeLensProvider(
      new InlineReview(connectedStore, connectedClient, log),
    );
    lensRegistration = vscode.languages.registerCodeLensProvider(
      [{ scheme: "file" }, { scheme: DIFF_SCHEME }],
      lenses,
    );
    decorations = new HunkDecorations(lenses, log);
    const connectedDecorations = decorations;
    commands = registerCommands(
      connectedStore,
      connectedClient,
      new NativeDiff(contents),
      async () => {
        await connectedStore.refresh();
        update();
      },
      restart,
      output,
      () => connectedView.selection[0],
      () => connectedDecorations.target(),
    );
    commands.push(connectedView.onDidChangeSelection(update));
    connectedStore.on("change", update);
    connectedClient.on("state", (state) => {
      if (state === "Disconnected") {
        connectedStore.clear();
        if (sharedEndpoint && !setupError && !disposed)
          reconnect.disconnected();
      } else if (state === "Ready") reconnect.connected();
      update();
    });
    update();
    try {
      await connectedClient.start();
      await connectedStore.restore();
    } catch (error) {
      log(String(error));
      // The persistent connection status reports shared failures. Repeated retry
      // failures must not open a new popup every few seconds.
      if (!sharedEndpoint) reportError(error);
    }
    update();
  };
  const restart = async (_automatic = false) => {
    // Serialize restart/configuration/deactivation so old responses cannot cross sessions.
    lifecycle = lifecycle.then(connect, connect);
    await lifecycle;
  };
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  const diskChanged = (uri: vscode.Uri) => {
    contents.refreshCurrent(uri);
    store?.clearLocations();
    lenses?.invalidate();
  };
  context.subscriptions.push(
    output,
    status,
    reconnect,
    contents,
    watcher,
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, contents),
    watcher.onDidCreate(diskChanged),
    watcher.onDidChange(diskChanged),
    watcher.onDidDelete(diskChanged),
    vscode.workspace.onDidSaveTextDocument((document) =>
      diskChanged(document.uri),
    ),
    vscode.workspace.onDidChangeTextDocument(() => lenses?.invalidate()),
    vscode.workspace.onDidCloseTextDocument(() => lenses?.invalidate()),
    vscode.workspace.onDidChangeWorkspaceFolders(
      () => void restart().catch(reportError),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("codexChanges.inlineReview"))
        lenses?.invalidate();
      if (
        event.affectsConfiguration("chatgpt.cliExecutable") ||
        [
          "connectionMode",
          "serverCommand",
          "serverArgs",
          "websocketUrl",
          "requestTimeoutMs",
        ].some((key) => event.affectsConfiguration(`codexChanges.${key}`))
      )
        void restart().catch(reportError);
    }),
    {
      dispose: () => {
        disposed = true;
        reconnect.dispose();
      },
    },
  );
  shutdown = async () => {
    disposed = true;
    reconnect.dispose();
    await lifecycle;
    await teardown();
  };
  await restart();
}
export async function deactivate(): Promise<void> {
  await shutdown?.();
  shutdown = undefined;
}
