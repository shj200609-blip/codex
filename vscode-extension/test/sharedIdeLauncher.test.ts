import { codexRoot } from "../scripts/paths.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

test("shared IDE executable proxies startup and preserves ordinary utility calls", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-ide-wrapper-"));
  try {
    const fake = join(root, "codex");
    writeFileSync(
      fake,
      "#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2),url:process.env.CODEX_APP_SERVER_URL??null}));\n",
      { mode: 0o755 },
    );
    const wrapper = resolve(codexRoot(), "scripts/codex-shared-ide");
    const env = {
      ...process.env,
      CODEX_SHARED_IDE_BINARY: fake,
      CODEX_APP_SERVER_URL: "ws://127.0.0.1:4500",
    };
    const run = (args: string[]) =>
      JSON.parse(execFileSync(wrapper, args, { env, encoding: "utf8" }));
    assert.deepEqual(
      run([
        "-c",
        "features.code_mode_host=true",
        "app-server",
        "--analytics-default-enabled",
      ]).args,
      ["--remote", env.CODEX_APP_SERVER_URL, "app-server", "proxy"],
    );
    assert.deepEqual(run(["--version"]), { args: ["--version"], url: null });
    assert.deepEqual(run(["exec", "app-server"]), {
      args: ["exec", "app-server"],
      url: null,
    });
    assert.deepEqual(run(["-c", "app-server", "--version"]), {
      args: ["-c", "app-server", "--version"],
      url: null,
    });
    assert.deepEqual(
      run(["app-server", "generate-ts", "--out", "/tmp/types"]),
      {
        args: ["app-server", "generate-ts", "--out", "/tmp/types"],
        url: null,
      },
    );
    const missing = { ...env };
    delete (missing as Partial<typeof env>).CODEX_APP_SERVER_URL;
    assert.throws(
      () =>
        execFileSync(wrapper, ["app-server"], { env: missing, stdio: "pipe" }),
      /CODEX_APP_SERVER_URL is required/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
