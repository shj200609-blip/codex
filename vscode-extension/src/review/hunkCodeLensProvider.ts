import * as vscode from "vscode";
import { InlineReview, type InlineAction } from "./inlineReview";
import { inlineDocument } from "./inlineDocument";

export class HunkCodeLensProvider
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly changed = () => this.emitter.fire();
  constructor(private readonly inline: InlineReview) {
    inline.on("change", this.changed);
  }
  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    const actions = await this.actionsFor(
      document,
      () => token.isCancellationRequested,
    );
    return actions.map(
      (action) =>
        new vscode.CodeLens(new vscode.Range(action.line, 0, action.line, 0), {
          title: action.title,
          command: action.command,
          tooltip: action.tooltip,
          arguments: [action.node],
        }),
    );
  }
  async actionsFor(
    document: vscode.TextDocument,
    cancelled: () => boolean = () => false,
  ): Promise<InlineAction[]> {
    if (
      !vscode.workspace
        .getConfiguration("codexChanges", document.uri)
        .get("inlineReview", true)
    )
      return [];
    const adapted = inlineDocument(document, cancelled);
    return adapted ? this.inline.actions(adapted) : [];
  }
  invalidate(): void {
    this.inline.invalidate();
  }
  dispose(): void {
    this.inline.off("change", this.changed);
    this.inline.dispose();
    this.emitter.dispose();
  }
}
