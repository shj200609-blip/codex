import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

// Published checkout: <repo>/vscode-extension. Existing development checkout:
// codex-ide/{codex,vscode-extension}. Both use the same generated Rust schema.
export function codexRoot(project = process.cwd()) {
  const parent = resolve(project, "..");
  for (const candidate of [parent, join(parent, "codex")]) {
    if (existsSync(join(candidate, "codex-rs", "Cargo.toml"))) return candidate;
  }
  throw new Error("Cannot find the Codex fork next to this extension project");
}
