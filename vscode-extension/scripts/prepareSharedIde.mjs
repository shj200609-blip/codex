import { codexRoot } from "./paths.mjs";
// Prepare an isolated VS Code profile using the installed official Codex IDE
// and the latest project Changes extension. Does not change regular user settings.
import { mkdir, writeFile, realpath, access } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values: options } = parseArgs({
  options: {
    server: { type: "string" },
    workspace: { type: "string" },
    "state-dir": { type: "string" },
    "codex-home": { type: "string" },
  },
});
for (const required of ["server", "workspace", "state-dir"]) {
  if (!options[required]) throw new Error(`Required: --${required}`);
}
const url = new URL(options.server);
if (
  url.protocol !== "ws:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  url.username ||
  url.password
)
  throw new Error(
    "Changes currently requires an unauthenticated loopback ws:// shared server",
  );
const workspace = await realpath(options.workspace);
const root = resolve(options["state-dir"]);
const binary = resolve(codexRoot(project), "codex-rs/target/debug/codex");
await access(binary);
// Require a new, private profile: never overwrite another profile's settings.
try {
  await access(join(root, "profile", "User", "settings.json"));
  throw new Error(
    "Profile already exists. Choose a fresh --state-dir to preserve its settings.",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
await mkdir(join(root, "profile", "User"), { recursive: true });
const wrapper = join(root, "shared-ide-cli");
await writeFile(
  wrapper,
  `#!/bin/sh\nexport CODEX_APP_SERVER_URL=${shellQuote(url.href)}\nexport CODEX_SHARED_IDE_BINARY=${shellQuote(binary)}\nexec ${shellQuote(resolve(codexRoot(project), "scripts/codex-shared-ide"))} "$@"\n`,
  { mode: 0o755 },
);
const settings = {
  "chatgpt.cliExecutable": wrapper,
  "chatgpt.openOnStartup": true,
  "window.title":
    "Shared Codex IDE • ${activeEditorShort}${separator}${rootName}",
  "codexChanges.connectionMode": "websocket",
  "codexChanges.websocketUrl": url.href,
  "editor.codeLens": true,
  "diffEditor.codeLens": true,
};
await writeFile(
  join(root, "profile", "User", "settings.json"),
  JSON.stringify(settings, null, 2) + "\n",
);
// LaunchServices brings a fresh macOS instance to the foreground. The Code CLI
// can leave the original launcher foreground when multiple Code instances exist.
const code =
  process.platform === "darwin"
    ? "/usr/bin/open -n -a '/Applications/Visual Studio Code.app' --args"
    : "'code'";
const launcher = join(root, "launch-ide.command");
const environment = options["codex-home"]
  ? `export CODEX_HOME=${shellQuote(resolve(options["codex-home"]))}\n`
  : "";
await writeFile(
  launcher,
  `#!/bin/sh\n${environment}exec ${code} --new-window --user-data-dir=${shellQuote(join(root, "profile"))} --extensionDevelopmentPath=${shellQuote(project)} --folder-uri=${shellQuote(pathToFileURL(workspace).href)}\n`,
  { mode: 0o755 },
);
await writeFile(
  join(root, "connection.json"),
  JSON.stringify(
    {
      server: url.href,
      workspace,
      binary,
      wrapper,
      profile: join(root, "profile"),
      launcher,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Prepared ${launcher}\nRun: sh "${launcher}"\nOnly the new isolated profile uses the shared IDE executable.`,
);
