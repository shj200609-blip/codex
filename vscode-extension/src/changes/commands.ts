import * as vscode from "vscode";
import type {
  RpcClient,
  ChangeSet,
  ChangeSetHunkResult,
} from "../appServer/protocol";
import {
  DisconnectedError,
  RpcError,
  ProtocolError,
  TransportError,
  isNotFound,
} from "../appServer/errors";
import { ChangeSetStore } from "./changeSetStore";
import {
  findFile,
  findHunk,
  hasPending,
  reference,
  type ReviewNode,
  type FileRef,
} from "./models";
import { NativeDiff } from "../diff/openDiff";
import { SAVE_BEFORE_REVIEW } from "../review/inlineReview";
import { changeGroupLabel, setPresentation } from "./changeTreeItems";

export function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (isNotFound(error))
    void vscode.window.showInformationMessage(
      `Review data not found: ${message}. Refresh to clear expired session data.`,
    );
  else if (error instanceof RpcError && error.code === -32601)
    void vscode.window.showInformationMessage(
      "This App Server does not support ChangeSet review. Configure the forked binary.",
    );
  else if (error instanceof RpcError)
    void vscode.window.showWarningMessage(
      `App Server rejected the review request: ${message}`,
    );
  else if (error instanceof DisconnectedError)
    void vscode.window.showErrorMessage(`Disconnected: ${message}`);
  else if (error instanceof ProtocolError)
    void vscode.window.showErrorMessage(`Protocol error: ${message}`);
  else if (error instanceof TransportError)
    void vscode.window.showErrorMessage(`Transport error: ${message}`);
  else void vscode.window.showErrorMessage(message);
}
function outcomes(results: ChangeSetHunkResult[]): void {
  const conflicts = results.filter((result) => result.state === "conflict");
  const unsupported = results.filter(
    (result) => result.state === "unsupported",
  );
  if (conflicts.length)
    void vscode.window.showWarningMessage(
      `${conflicts.length} change(s) conflict. Open Diff to inspect. ${conflicts[0].message ?? ""}`,
    );
  if (unsupported.length)
    void vscode.window.showInformationMessage(
      `${unsupported.length} change(s) are unsupported. ${unsupported[0].message ?? ""}`,
    );
}
function dirtyFiles(set: ChangeSet, fileId?: string): boolean {
  const paths = new Set(
    set.files
      .filter((file) => !fileId || file.id === fileId)
      .map((file) => vscode.Uri.parse(file.path).toString()),
  );
  if (
    vscode.workspace.textDocuments.some(
      (document) => document.isDirty && paths.has(document.uri.toString()),
    )
  ) {
    void vscode.window.showWarningMessage(SAVE_BEFORE_REVIEW);
    return true;
  }
  return false;
}
export function registerCommands(
  store: ChangeSetStore,
  client: RpcClient,
  diff: NativeDiff,
  refresh: () => Promise<void>,
  restart: () => Promise<void>,
  output: vscode.OutputChannel,
  selection: () => ReviewNode | undefined = () => undefined,
  activeTarget: () => Promise<ReviewNode | undefined> = async () => undefined,
): vscode.Disposable[] {
  const busy = new Set<string>();
  const register = (
    name: string,
    handler: (node?: ReviewNode) => Promise<void>,
  ) =>
    vscode.commands.registerCommand(
      `codexChanges.${name}`,
      async (node?: ReviewNode) => {
        try {
          await handler(node);
        } catch (error) {
          reportError(error);
        }
      },
    );
  const fileFor = (node: ReviewNode | undefined) => {
    if (!node || node.kind === "changeSet") return undefined;
    const set = store.get(node.ref);
    const file = set && findFile(set, node.ref);
    return file && set ? { set, file, ref: node.ref } : undefined;
  };
  const review = async (
    node: ReviewNode | undefined,
    level: "Hunk" | "File" | "All",
    action: "accept" | "revert",
  ) => {
    let set: ChangeSet | undefined;
    // Title/Palette bulk actions respect the user's selected Tree set/file/hunk.
    // Explicit CodeLens and context-menu arguments always win over that selection.
    if (!node && level === "All") node = selection();
    if (node) set = store.get(node.ref);
    else if (level === "All") {
      const sets = store.all.filter(hasPending);
      if (store.all.length === 1) set = sets[0];
      else if (sets.length > 0) {
        const choice = await vscode.window.showQuickPick(
          sets.map((value) => ({
            label: changeGroupLabel(store.all, reference(value)),
            description: setPresentation(value).description,
            set: value,
          })),
          { placeHolder: "Choose the changes to review" },
        );
        set = choice?.set;
      }
    }
    // A picker can remain open across another client's update. Re-read the
    // authoritative snapshot immediately before validating/sending any RPC.
    set = set && store.get(reference(set));
    if (!set || !hasPending(set)) return;
    const ref = reference(set);
    const fileRef = node && node.kind !== "changeSet" ? node.ref : undefined;
    if (level !== "All" && !fileRef) return;
    const file = fileRef && findFile(set, fileRef);
    if (level !== "All" && (!file || !hasPending(file))) return;
    if (
      level === "Hunk" &&
      (node?.kind !== "hunk" ||
        !file ||
        findHunk(file, node.ref)?.state !== "pending")
    )
      return;
    if (dirtyFiles(set, level === "All" ? undefined : fileRef?.fileId)) return;
    if (busy.has(set.id)) return;
    busy.add(set.id);
    try {
      let results: ChangeSetHunkResult[];
      if (level === "Hunk" && node?.kind === "hunk")
        results = await store.review(`changeSet/hunk/${action}`, node.ref);
      else if (level === "File" && fileRef)
        results = await store.review(
          `changeSet/file/${action}`,
          fileRef as FileRef,
        );
      else results = await store.review(`changeSet/${action}`, ref);
      outcomes(results);
    } finally {
      busy.delete(set.id);
    }
  };
  return [
    register("openFile", async (node) => {
      const value = fileFor(node);
      if (value) await diff.open(value.ref, value.file);
    }),
    register("openHunk", async (node) => {
      if (node?.kind !== "hunk") return;
      const value = fileFor(node);
      if (!value) return;
      const response = await client.request("changeSet/hunk/locate", node.ref);
      if (store.get(node.ref) !== value.set) return;
      store.setLocation(node.ref, response.result);
      switch (response.result.status) {
        case "located":
          await diff.open(node.ref, value.file, response.result);
          break;
        case "conflict":
          await diff.open(node.ref, value.file);
          await vscode.window.showWarningMessage(
            `Hunk location conflict: ${response.result.reason}`,
          );
          break;
        case "unsupported":
          await vscode.window.showInformationMessage(
            `Unsupported hunk location: ${response.result.reason}`,
          );
          break;
        case "notPresent":
          if (response.result.reason === "reverted")
            await vscode.window.showInformationMessage(
              "This change has already been reverted.",
            );
          else {
            await diff.open(node.ref, value.file);
            await vscode.window.showInformationMessage(
              response.result.reason === "fileDeleted"
                ? "This file is deleted; the diff shows its baseline against an empty current file."
                : "The current file is missing.",
            );
          }
      }
    }),
    ...(["Hunk", "File", "All"] as const).flatMap((level) =>
      (["accept", "revert"] as const).map((action) =>
        register(`${action}${level}`, (node) => review(node, level, action)),
      ),
    ),
    register("acceptCurrent", async () =>
      review(await activeTarget(), "Hunk", "accept"),
    ),
    register("revertCurrent", async () =>
      review(await activeTarget(), "Hunk", "revert"),
    ),
    register("refresh", refresh),
    register("restart", restart),
    register("showOutput", async () => {
      output.show();
    }),
  ];
}
