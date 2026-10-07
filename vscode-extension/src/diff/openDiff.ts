import * as vscode from "vscode";
import type { ChangeSetFile, HunkLocationResult } from "../appServer/protocol";
import type { FileRef } from "../changes/models";
import { DiffContentProvider } from "./diffContentProvider";
import { locationRange } from "./range";
import { SAVE_BEFORE_REVIEW } from "../review/inlineReview";

export class NativeDiff {
  constructor(private readonly contents: DiffContentProvider) {}
  async open(
    ref: FileRef,
    file: ChangeSetFile,
    location?: HunkLocationResult,
  ): Promise<void> {
    if (
      file.state === "unsupported" ||
      file.unsupportedReason ||
      (file.beforeContent === null && file.changeType !== "added")
    ) {
      await vscode.window.showInformationMessage(
        `Unsupported file: ${file.unsupportedReason ?? "The server did not supply a text baseline."}`,
      );
      return;
    }
    const path = vscode.Uri.parse(file.path, true);
    if (path.scheme !== "file" || path.authority) {
      await vscode.window.showInformationMessage(
        "Remote file review is unsupported in this MVP.",
      );
      return;
    }
    const left = this.contents.uri(ref, file, "baseline");
    let right = path;
    try {
      const stat = await vscode.workspace.fs.stat(path);
      if (stat.type !== vscode.FileType.File) {
        await vscode.window.showInformationMessage(
          "The current path is not a regular file.",
        );
        return;
      }
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      )
        right = this.contents.uri(ref, file, "current");
      else throw error;
    }
    const document = await vscode.workspace.openTextDocument(right);
    if (document.isDirty) {
      await vscode.window.showWarningMessage(
        `${SAVE_BEFORE_REVIEW} The locator uses saved disk content; the diff will omit its selection.`,
      );
      // The native diff can show the buffer, but no disk-derived range is applied to it.
      location = undefined;
    }
    const converted =
      location?.status === "located"
        ? locationRange(
            location,
            document.lineCount,
            (line) => document.lineAt(line).text.length,
          )
        : undefined;
    const selection = converted
      ? new vscode.Range(
          converted.startLine,
          converted.startCharacter,
          converted.endLine,
          converted.endCharacter,
        )
      : undefined;
    // TextDocumentShowOptions.selection also works when revealing a reused diff editor.
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      `${vscode.workspace.asRelativePath(path, false)} — Baseline ↔ Current${right === path ? "" : " (file absent)"}`,
      {
        preview: true,
        ...(selection ? { selection } : {}),
      } satisfies vscode.TextDocumentShowOptions,
    );
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === right.toString(),
    );
    if (editor && selection) {
      editor.selection = new vscode.Selection(selection.start, selection.end);
      editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
    }
  }
}
