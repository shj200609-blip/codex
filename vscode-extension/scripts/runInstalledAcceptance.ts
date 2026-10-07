import { codexRoot } from "./paths.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";
import WebSocket, { WebSocketServer } from "ws";
import { writeRegistration } from "../src/sharedIde/registration";

async function main() {
  const root = await mkdtemp("/private/tmp/codex-installed-host-");
  const project = resolve(__dirname, "..");
  const binary = resolve(codexRoot(project), "codex-rs/target/debug/codex");
  const workspace = join(root, "workspace"),
    profile = join(root, "profile");
  await mkdir(join(workspace, ".vscode"), { recursive: true });
  await mkdir(join(profile, "User"), { recursive: true });
  const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => relay.once("listening", resolve));
  const endpoint = `ws://127.0.0.1:${(relay.address() as { port: number }).port}/`;
  let blocked = false;
  relay.on("connection", (client) => {
    if (blocked) {
      client.terminate();
      return;
    }
    const upstream = new WebSocket("ws://127.0.0.1:4510");
    const buffered: Buffer[] = [];
    upstream.on("open", () => {
      for (const bytes of buffered) upstream.send(bytes.toString());
      buffered.length = 0;
    });
    client.on("message", (bytes) => {
      if (upstream.readyState === WebSocket.OPEN)
        upstream.send(bytes.toString());
      else buffered.push(Buffer.from(bytes as Buffer));
    });
    upstream.on("message", (bytes) => {
      if (client.readyState === WebSocket.OPEN) client.send(bytes.toString());
    });
    client.on("close", () => upstream.terminate());
    upstream.on("close", () => client.terminate());
    upstream.on("error", () => client.terminate());
  });
  const wrapperPath = join(
    profile,
    "User/globalStorage/codex-local.codex-changes-review/shared-ide/codex-shared-ide",
  );
  await writeRegistration({
    version: 1,
    endpoint,
    forkExecutable: binary,
    utilityExecutable: binary,
    wrapperPath,
  });
  await writeFile(
    join(profile, "User/settings.json"),
    JSON.stringify({ "chatgpt.cliExecutable": wrapperPath }),
  );
  const marker = join(root, "unexpected-local-process");
  const forbidden = join(root, "must-not-start-local-core");
  await writeFile(forbidden, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, {
    mode: 0o700,
  });
  await writeFile(
    join(workspace, ".vscode/settings.json"),
    JSON.stringify({
      "codexChanges.connectionMode": "stdio",
      "codexChanges.serverCommand": forbidden,
      "codexChanges.websocketUrl": "ws://127.0.0.1:1",
    }),
  );
  await writeFile(
    join(root, "test-state.json"),
    JSON.stringify({ endpoint, workspace }),
  );
  const entry = join(root, "installedHostAcceptance.js");
  await build({
    entryPoints: [join(project, "scripts/installedHostAcceptance.ts")],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["vscode"],
  });
  const code =
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
  const args = [
    "--user-data-dir",
    profile,
    "--extensions-dir",
    join(root, "extensions"),
    "--extensionDevelopmentPath",
    project,
    "--extensionTestsPath",
    entry,
    "--disable-extensions",
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
    "--new-window",
    "--wait",
    workspace,
  ];
  const exists = (name: string) =>
    access(join(root, name)).then(
      () => true,
      () => false,
    );
  const watcher = setInterval(() => {
    void (async () => {
      if (
        !blocked &&
        (await exists("drop-connection")) &&
        !(await exists("disconnection-observed"))
      ) {
        blocked = true;
        for (const client of relay.clients) client.terminate();
      }
      if (blocked && (await exists("disconnection-observed"))) blocked = false;
    })();
  }, 50);
  console.log(`Installed connection acceptance fixture: ${root}`);
  try {
    for (const phase of ["first", "reopened"]) {
      await promisify(execFile)(code, args, {
        env: {
          ...process.env,
          CODEX_INSTALLED_TEST_ROOT: root,
          CODEX_INSTALLED_TEST_PHASE: phase,
        },
        timeout: 90000,
      });
      const end = Date.now() + 35000;
      while (!(await exists(`host-${phase}.json`))) {
        if (await exists(`host-${phase}-error.txt`))
          throw new Error(
            await readFile(join(root, `host-${phase}-error.txt`), "utf8"),
          );
        if (Date.now() >= end) throw new Error(`Host result missing: ${root}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const result = JSON.parse(
        await readFile(join(root, `host-${phase}.json`), "utf8"),
      );
      assert.equal(result.ready.endpoint, endpoint);
      assert.equal(await exists("unexpected-local-process"), false);
      console.log(
        `PASS ${phase}: saved producer endpoint overrides stale workspace URL, no local Core${phase === "first" ? ", automatic reconnect without a window reload" : ", reopening retains the same registration"}`,
      );
    }
    const artifacts = join(project, "acceptance-results/installed-ide");
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      join(artifacts, "host-run.json"),
      JSON.stringify(
        {
          root,
          endpoint,
          workspace,
          checks: [
            "trusted workspace activates automatically",
            "persistent IDE registration wins over obsolete workspace connection mode and URL",
            "no private process starts",
            "connection recovery without reloading the window",
            "reopened profile retains registration",
          ],
          first: JSON.parse(
            await readFile(join(root, "host-first.json"), "utf8"),
          ),
          reopened: JSON.parse(
            await readFile(join(root, "host-reopened.json"), "utf8"),
          ),
        },
        null,
        2,
      ),
    );
  } finally {
    clearInterval(watcher);
    for (const client of relay.clients) client.terminate();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
