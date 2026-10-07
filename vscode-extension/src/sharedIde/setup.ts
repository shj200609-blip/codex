import * as vscode from "vscode";
import { isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppServerClient } from "../appServer/client";
import { WebSocketTransport } from "../appServer/transport";
import {
  readRegistration,
  validateEndpoint,
  writeRegistration,
} from "./registration";

export function registerSharedIdeSetup(
  context: vscode.ExtensionContext,
  log: (message: string) => void,
  onConfigured: () => Promise<void>,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("codexChanges.connectIde", async () => {
      try {
        if (
          !vscode.workspace.isTrusted ||
          vscode.env.remoteName ||
          process.platform === "win32"
        )
          throw new Error(
            "Shared IDE setup currently supports trusted local macOS/Linux workspaces.",
          );
        const ide = vscode.extensions.getExtension("openai.chatgpt");
        if (!ide)
          throw new Error("Install the official Codex IDE extension first.");
        const config = vscode.workspace.getConfiguration("chatgpt");
        const original = config.get<string>("cliExecutable");
        const previous = await readRegistration(original);
        const input = await vscode.window.showInputBox({
          title: "Connect Codex IDE and Changes to one shared server",
          prompt:
            "Running shared server URL. Your current VS Code login and profile are retained.",
          value:
            previous?.endpoint ??
            vscode.workspace
              .getConfiguration("codexChanges")
              .get<string>("websocketUrl"),
          validateInput: (value) => {
            try {
              validateEndpoint(value);
              return;
            } catch (error) {
              return String(error);
            }
          },
        });
        if (input === undefined) return;
        const selected = await vscode.window.showOpenDialog({
          title:
            "Select the forked codex CLI executable (supports app-server proxy)",
          canSelectFolders: false,
          canSelectMany: false,
          defaultUri: previous
            ? vscode.Uri.file(previous.forkExecutable)
            : undefined,
          openLabel: "Use this Codex CLI",
        });
        if (!selected?.[0]) return;
        const endpoint = validateEndpoint(input);
        await promisify(execFile)(
          selected[0].fsPath,
          ["--remote", endpoint, "app-server", "proxy", "--help"],
          { timeout: 10000 },
        );
        // Prove the endpoint is reachable before changing the producer setting.
        const probe = new AppServerClient(
          new WebSocketTransport(endpoint),
          log,
        );
        try {
          await probe.start();
        } finally {
          await probe.stop();
        }
        const platform = process.platform === "darwin" ? "macos" : "linux";
        const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
        const bundled = join(
          ide.extensionPath,
          "bin",
          `${platform}-${arch}`,
          "codex",
        );
        const priorExecutable = previous
          ? previous.previousCliExecutable
          : original;
        if (priorExecutable && !isAbsolute(priorExecutable))
          throw new Error(
            "Your custom IDE executable is relative. Make it an absolute path before shared setup so its utility behavior can be preserved.",
          );
        const utilityExecutable =
          previous?.utilityExecutable ??
          (priorExecutable && isAbsolute(priorExecutable)
            ? priorExecutable
            : bundled);
        const registration = {
          version: 1 as const,
          endpoint,
          forkExecutable: selected[0].fsPath,
          utilityExecutable,
          wrapperPath: join(
            context.globalStorageUri.fsPath,
            "shared-ide",
            "codex-shared-ide",
          ),
          previousCliExecutable: priorExecutable,
        };
        await writeRegistration(registration);
        await config.update(
          "cliExecutable",
          registration.wrapperPath,
          vscode.ConfigurationTarget.Global,
        );
        await onConfigured();
        log(
          `Shared IDE configured: ${endpoint}. Ordinary VS Code profile and authentication are retained.`,
        );
        // Do not reload or terminate an existing IDE producer in the middle of a turn.
        await vscode.window.showInformationMessage(
          "Shared IDE connection saved. Finish existing chats, then reload this window once. Future trusted workspaces connect automatically; no separate profile or repeated login is needed.",
        );
      } catch (error) {
        void vscode.window.showErrorMessage(String(error));
      }
    }),
    vscode.commands.registerCommand("codexChanges.disconnectIde", async () => {
      const config = vscode.workspace.getConfiguration("chatgpt");
      const registration = await readRegistration(
        config.get<string>("cliExecutable"),
      );
      if (!registration) return;
      await config.update(
        "cliExecutable",
        registration.previousCliExecutable,
        vscode.ConfigurationTarget.Global,
      );
      await vscode.window.showInformationMessage(
        "Original Codex IDE executable restored. Finish existing chats before reloading once.",
      );
    }),
  ];
}
