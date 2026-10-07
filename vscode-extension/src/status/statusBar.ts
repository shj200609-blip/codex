import * as vscode from "vscode";
import type { ConnectionState } from "../appServer/client";
export class ConnectionStatus implements vscode.Disposable {
  private item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    10,
  );
  constructor() {
    this.item.command = "codexChanges.showOutput";
    this.item.show();
  }
  update(state: ConnectionState): void {
    this.item.text =
      state === "Ready"
        ? "$(diff) Codex Changes"
        : state === "Connecting"
          ? "$(sync~spin) Codex: Connecting"
          : "$(debug-disconnect) Codex: Reconnect";
    this.item.command =
      state === "Disconnected"
        ? "codexChanges.restart"
        : "codexChanges.showOutput";
    this.item.tooltip =
      state === "Disconnected"
        ? "App Server disconnected. Click to reconnect. Review covers tracked apply_patch edits only."
        : "Review covers tracked apply_patch edits only. Click for the App Server log.";
    this.item.tooltip +=
      "\nChanges made through untracked shell, MCP, hook or background writes may not appear here.";
  }
  dispose(): void {
    this.item.dispose();
  }
}
