import * as vscode from "vscode";
import type { HunkCodeLensProvider } from "./hunkCodeLensProvider";
import type { InlineAction } from "./inlineReview";
import { refKey, type ReviewNode } from "../changes/models";

export function hunkLineRange(document: vscode.TextDocument, line: number) {
  // Whole-line decorations already fill the row. Including the newline also
  // paints the following row, which may be outside the Core-located hunk.
  return document.lineAt(line).range;
}

// Presentation cache only: Core decides the ranges and command handlers re-read
// server decisions. A document/store event immediately clears all old frames.
export class HunkDecorations implements vscode.Disposable {
  private readonly types = [
    "1px 1px 0 3px",
    "0 1px 0 3px",
    "0 1px 1px 3px",
    "1px 1px 1px 3px",
  ].map((borderWidth) =>
    vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderStyle: "solid",
      borderWidth,
      borderColor: new vscode.ThemeColor("editorGutter.addedBackground"),
      backgroundColor: new vscode.ThemeColor(
        "diffEditor.insertedTextBackground",
      ),
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    }),
  );
  private readonly subscriptions: vscode.Disposable[];
  private readonly shown = new Map<vscode.TextEditor, InlineAction[]>();
  private epoch = 0;
  private timer?: NodeJS.Timeout;
  private disposed = false;
  constructor(
    private readonly provider: HunkCodeLensProvider,
    private readonly log: (message: string) => void,
  ) {
    this.subscriptions = [
      provider.onDidChangeCodeLenses(() => this.invalidate()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.invalidate()),
      vscode.window.onDidChangeActiveTextEditor(() => this.context()),
      vscode.window.onDidChangeTextEditorSelection(() => this.context()),
    ];
    this.invalidate();
  }
  private context() {
    const editor = vscode.window.activeTextEditor;
    const actions = editor && this.shown.get(editor);
    void vscode.commands.executeCommand(
      "setContext",
      "codexChanges.inlinePending",
      !!actions?.some((action) => action.command === "codexChanges.acceptHunk"),
    );
  }
  private clear() {
    for (const editor of vscode.window.visibleTextEditors)
      for (const type of this.types) editor.setDecorations(type, []);
    this.shown.clear();
    this.context();
  }
  private invalidate() {
    this.epoch++;
    this.clear();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.render().catch((error) => this.log(String(error)));
    }, 80);
  }
  private async render() {
    const epoch = this.epoch;
    await Promise.all(
      vscode.window.visibleTextEditors.map(async (editor) => {
        const actions = await this.provider.actionsFor(
          editor.document,
          () => this.disposed || epoch !== this.epoch,
        );
        if (this.disposed || epoch !== this.epoch) return;
        this.shown.set(editor, actions);
        const pending = new Set(
          actions
            .filter((a) => a.command === "codexChanges.acceptHunk")
            .map((a) => refKey(a.node.ref)),
        );
        const rows: vscode.DecorationOptions[][] = [[], [], [], []];
        for (const action of actions) {
          if (!action.range || !pending.has(refKey(action.node.ref))) continue;
          const { startLine, endLine } = action.range;
          for (let line = startLine; line <= endLine; line++) {
            const part =
              startLine === endLine
                ? 3
                : line === startLine
                  ? 0
                  : line === endLine
                    ? 2
                    : 1;
            rows[part].push({
              range: hunkLineRange(editor.document, line),
              hoverMessage: action.title,
            });
          }
        }
        this.types.forEach((type, index) =>
          editor.setDecorations(type, rows[index]),
        );
      }),
    );
    this.context();
  }
  async target(): Promise<ReviewNode | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    // Resolve afresh for a toolbar gesture; cached line positions never authorize
    // an operation. Ambiguous overlapping sets always require an explicit choice.
    const epoch = this.epoch;
    const actions = await this.provider.actionsFor(
      editor.document,
      () => this.disposed || epoch !== this.epoch,
    );
    if (this.disposed || epoch !== this.epoch) return undefined;
    const pending = actions.filter(
      (a) => a.command === "codexChanges.acceptHunk",
    );
    const ranges = new Map(
      actions.filter((a) => a.range).map((a) => [refKey(a.node.ref), a.range!]),
    );
    const line = editor.selection.active.line;
    const underCursor = pending.filter((a) => {
      const range = ranges.get(refKey(a.node.ref));
      return range && line >= range.startLine && line <= range.endLine;
    });
    if (underCursor.length === 1) return underCursor[0].node;
    const choices = underCursor.length ? underCursor : pending;
    if (!choices.length) return undefined;
    return (
      await vscode.window.showQuickPick(
        choices.map((action) => ({
          label: `${action.groupLabel ?? "Changes"} · Line ${action.line + 1}`,
          node: action.node,
        })),
        { placeHolder: "Choose the change to review" },
      )
    )?.node;
  }
  dispose() {
    this.disposed = true;
    this.epoch++;
    clearTimeout(this.timer);
    this.clear();
    this.subscriptions.forEach((item) => item.dispose());
    this.types.forEach((type) => type.dispose());
  }
}
