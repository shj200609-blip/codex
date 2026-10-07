import * as vscode from "vscode";
import type { InlineDocument } from "./inlineReview";
import { decodeIdentity } from "../diff/identity";
import { refKey, type FileRef } from "../changes/models";
import { DIFF_SCHEME } from "../diff/diffContentProvider";

export function inlineDocument(
  document: vscode.TextDocument,
  cancelled: () => boolean = () => false,
): InlineDocument | undefined {
  let scope: FileRef | undefined;
  if (document.uri.scheme === DIFF_SCHEME) {
    try {
      const identity = decodeIdentity(document.uri.query);
      if (identity.side !== "current") return undefined;
      scope = identity.ref;
    } catch {
      return undefined;
    }
  } else if (document.uri.scheme !== "file") return undefined;
  const version = document.version;
  const dirty = document.isDirty;
  return {
    lineCount: document.lineCount,
    matches: (ref, file) =>
      scope
        ? refKey(ref) === refKey(scope)
        : vscode.Uri.parse(file.path).toString() === document.uri.toString(),
    dirty: (file) =>
      document.isDirty ||
      vscode.workspace.textDocuments.some(
        (doc) =>
          doc.isDirty &&
          doc.uri.toString() === vscode.Uri.parse(file.path).toString(),
      ),
    isCurrent: () =>
      !cancelled() &&
      !document.isClosed &&
      document.version === version &&
      document.isDirty === dirty,
  };
}
