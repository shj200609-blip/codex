// One-time setup in the ordinary VS Code profile. Does not launch a new profile,
// sign in, reload a window, copy credentials, or alter the system codex command.
import { readFile, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { AppServerClient } from "../src/appServer/client";
import { WebSocketTransport } from "../src/appServer/transport";
import {
  readRegistration,
  validateEndpoint,
  writeRegistration,
} from "../src/sharedIde/registration";
import { updateJsoncSetting } from "./jsoncSetting";

async function main() {
  const { values } = parseArgs({
    options: {
      server: { type: "string" },
      binary: { type: "string" },
      settings: { type: "string" },
      utility: { type: "string" },
    },
  });
  for (const key of ["server", "binary", "settings", "utility"] as const)
    if (!values[key]) throw new Error(`Required: --${key}`);
  const settings = resolve(values.settings!);
  const source = await readFile(settings, "utf8");
  const parsed = ts.parseConfigFileTextToJson(settings, source);
  if (parsed.error) throw new Error("Invalid settings JSONC; no changes made.");
  const original: string | undefined = parsed.config["chatgpt.cliExecutable"];
  const previous = await readRegistration(original);
  const endpoint = validateEndpoint(values.server!);
  const binary = resolve(values.binary!);
  await access(binary);
  // This only parses capabilities, without initializing or starting Core.
  execFileSync(
    binary,
    ["--remote", endpoint, "app-server", "proxy", "--help"],
    { stdio: "pipe" },
  );
  const probe = new AppServerClient(new WebSocketTransport(endpoint), () => {});
  try {
    await probe.start();
  } finally {
    await probe.stop();
  }
  const registration = {
    version: 1 as const,
    endpoint,
    forkExecutable: binary,
    utilityExecutable:
      previous?.utilityExecutable ?? original ?? resolve(values.utility!),
    wrapperPath: join(
      dirname(settings),
      "globalStorage",
      "codex-local.codex-changes-review",
      "shared-ide",
      "codex-shared-ide",
    ),
    previousCliExecutable: previous ? previous.previousCliExecutable : original,
  };
  const updated = updateJsoncSetting(
    source,
    "chatgpt.cliExecutable",
    registration.wrapperPath,
  );
  await writeRegistration(registration);
  await writeFile(
    join(dirname(registration.wrapperPath), "original-settings.jsonc"),
    source,
    { mode: 0o600, flag: "wx" },
  ).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  // Refuse to overwrite edits made while the connection probe was in flight.
  if ((await readFile(settings, "utf8")) !== source)
    throw new Error(
      "Settings changed during setup; retry without overwriting those edits.",
    );
  await writeFile(settings, updated);
  console.log(
    JSON.stringify(
      {
        endpoint,
        settings,
        wrapper: registration.wrapperPath,
        existingProfileRetained: true,
        reloadPerformed: false,
      },
      null,
      2,
    ),
  );
}
void main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
