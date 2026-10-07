import * as vscode from "vscode";
import type { ChangeSetFile } from "../appServer/protocol";
import type { FileRef } from "../changes/models";
import { virtualIdentity, type DiffSide } from "./identity";

export const DIFF_SCHEME = "codex-change";
export class DiffContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private contents = new Map<
    string,
    { side: DiffSide; baseline: string; path: vscode.Uri; uri: vscode.Uri }
  >();
  uri(ref: FileRef, file: ChangeSetFile, side: DiffSide): vscode.Uri {
    const path = vscode.Uri.parse(file.path, true);
    const basename = path.path.split("/").pop() || "file";
    const uri = vscode.Uri.from({
      scheme: DIFF_SCHEME,
      path: `/${side}/${basename}`,
      query: virtualIdentity(ref, side),
    });
    this.contents.set(uri.toString(), {
      side,
      baseline: file.beforeContent ?? "",
      path,
      uri,
    });
    return uri;
  }
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const entry = this.contents.get(uri.toString());
    if (!entry)
      throw new Error(
        "This Codex baseline belongs to an expired review session. Reopen the diff from CHANGES.",
      );
    if (entry.side === "baseline") return entry.baseline;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        await vscode.workspace.fs.readFile(entry.path),
      );
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      )
        return "";
      throw error;
    }
  }
  refreshCurrent(path?: vscode.Uri): void {
    for (const entry of this.contents.values())
      if (
        entry.side === "current" &&
        (!path || path.toString() === entry.path.toString())
      )
        this.emitter.fire(entry.uri);
  }
  dispose(): void {
    this.contents.clear();
    this.emitter.dispose();
  }
}
