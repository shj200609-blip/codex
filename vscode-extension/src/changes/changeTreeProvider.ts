import * as vscode from "vscode";
import { ChangeSetStore } from "./changeSetStore";
import {
  reference,
  refKey,
  findFile,
  findHunk,
  type ReviewNode,
} from "./models";
import {
  hunkPresentation,
  filePresentation,
  setPresentation,
  changeGroupLabel,
} from "./changeTreeItems";

export class ChangeTreeProvider
  implements vscode.TreeDataProvider<ReviewNode>, vscode.Disposable
{
  private emitter = new vscode.EventEmitter<ReviewNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly changed = () => this.emitter.fire(undefined);
  constructor(private readonly store: ChangeSetStore) {
    store.on("change", this.changed);
  }
  getChildren(node?: ReviewNode): ReviewNode[] {
    if (!node) {
      const sets = this.store.all;
      if (sets.length === 1)
        return sets[0].files.map((file) => ({
          kind: "file",
          ref: { ...reference(sets[0]), fileId: file.id },
        }));
      return sets.map((set) => ({ kind: "changeSet", ref: reference(set) }));
    }
    const set = this.store.get(node.ref);
    if (!set) return [];
    if (node.kind === "changeSet")
      return set.files.map((file) => ({
        kind: "file",
        ref: { ...node.ref, fileId: file.id },
      }));
    if (node.kind === "file")
      return (
        findFile(set, node.ref)?.hunks.map((hunk) => ({
          kind: "hunk",
          ref: { ...node.ref, hunkId: hunk.id },
        })) ?? []
      );
    return [];
  }
  getParent(node: ReviewNode): ReviewNode | undefined {
    const set = this.store.get(node.ref);
    if (!set || node.kind === "changeSet") return undefined;
    const file = findFile(set, node.ref);
    if (!file) return undefined;
    if (node.kind === "hunk")
      return findHunk(file, node.ref)
        ? { kind: "file", ref: { ...reference(set), fileId: file.id } }
        : undefined;
    return this.store.all.length > 1
      ? { kind: "changeSet", ref: reference(set) }
      : undefined;
  }
  getTreeItem(node: ReviewNode): vscode.TreeItem {
    const set = this.store.get(node.ref);
    if (!set) return new vscode.TreeItem("No active changes");
    const file =
      node.kind !== "changeSet" ? findFile(set, node.ref) : undefined;
    const hunk =
      node.kind === "hunk" && file ? findHunk(file, node.ref) : undefined;
    const presentation =
      hunk && node.kind === "hunk"
        ? hunkPresentation(hunk, this.store.location(node.ref))
        : file
          ? filePresentation(
              file,
              vscode.workspace.asRelativePath(
                vscode.Uri.parse(file.path),
                false,
              ),
            )
          : setPresentation(set, changeGroupLabel(this.store.all, node.ref));
    const item = new vscode.TreeItem(
      presentation.label,
      node.kind === "hunk" || (file && !file.hunks.length)
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = refKey(node.ref);
    item.description = presentation.description;
    item.tooltip = [
      presentation.tooltip,
      `Thread: ${set.threadId}`,
      `Turn: ${set.turnId}`,
      `ChangeSet: ${set.id}`,
      file ? `File: ${file.id}` : "",
      hunk ? `Hunk: ${hunk.id}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    item.contextValue = presentation.contextValue;
    if (presentation.icon)
      item.iconPath = new vscode.ThemeIcon(presentation.icon);
    item.accessibilityInformation = {
      label: [
        presentation.label,
        presentation.description,
        hunk?.state ?? file?.state ?? set.state,
      ]
        .filter(Boolean)
        .join(", "),
    };
    if (node.kind !== "changeSet")
      item.command = {
        command:
          node.kind === "hunk"
            ? "codexChanges.openHunk"
            : "codexChanges.openFile",
        title: "Open Diff",
        arguments: [node],
      };
    return item;
  }
  dispose(): void {
    this.store.off("change", this.changed);
    this.emitter.dispose();
  }
}
