import { codexRoot } from "./paths.mjs";
import { build } from "esbuild";
import {
  mkdtemp,
  mkdir,
  realpath,
  writeFile,
  readFile,
  readdir,
  cp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSync, closeSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(
  join(
    process.platform === "darwin" ? "/private/tmp" : await realpath(tmpdir()),
    "codex-lifecycle-host-",
  ),
);
const workspace = join(root, "workspace");
await mkdir(join(workspace, ".vscode"), { recursive: true });
await writeFile(
  join(workspace, ".vscode/settings.json"),
  JSON.stringify({
    "codexChanges.connectionMode": "websocket",
    "codexChanges.websocketUrl": "ws://127.0.0.1:1",
    "diffEditor.codeLens": true,
  }),
);
const fd = openSync(join(root, "fixture.log"), "a");
const fixture = spawn(
  process.execPath,
  ["--import", "tsx", "scripts/demo.ts", "--two-turns"],
  {
    cwd: project,
    env: {
      ...process.env,
      CODEX_DEMO_WORKSPACE: workspace,
      CODEX_DEMO_STATE_DIR: root,
    },
    stdio: ["ignore", fd, fd],
  },
);
closeSync(fd);
process.once("exit", () => fixture.kill("SIGTERM"));
for (let attempt = 0; attempt < 150; attempt++) {
  const ready = await readFile(join(root, "state.json"), "utf8")
    .then(JSON.parse)
    .catch(() => undefined);
  if (ready?.references?.length === 2) break;
  if (fixture.exitCode !== null)
    throw new Error(`Shared fixture exited: ${root}/fixture.log`);
  await new Promise((done) => setTimeout(done, 100));
}
const ready = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
console.log(
  `External fixture with ${ready.references.length} retained sets: ${ready.url}`,
);
await mkdir(join(root, "owned-home"), { recursive: true });
const helper = join(root, "lifecycle-driver");
await mkdir(helper);
await writeFile(
  join(helper, "package.json"),
  JSON.stringify({
    name: "codex-lifecycle-driver",
    publisher: "codex-test",
    version: "0.0.1",
    engines: { vscode: "^1.95.0" },
    main: "./main.js",
    activationEvents: ["onStartupFinished"],
  }),
);
await build({
  stdin: {
    contents:
      'import { run } from "./lifecycleAcceptance"; export function activate() { setTimeout(() => { void run().catch(console.error); }, 300); }',
    resolveDir: join(project, "scripts"),
    loader: "ts",
  },
  outfile: join(helper, "main.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
});
const executable =
  process.env.VSCODE_BIN ??
  (process.platform === "darwin"
    ? "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
    : "code");
console.log(`Isolated Extension Host acceptance: ${root}`);
async function launchHost() {
  const launch = promisify(execFile)(
    executable,
    [
      "--user-data-dir",
      join(root, "vscode-data"),
      "--extensions-dir",
      join(root, "extensions"),
      "--extensionDevelopmentPath",
      project,
      "--extensionDevelopmentPath",
      helper,
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--new-window",
      workspace,
    ],
    {
      env: {
        ...process.env,
        CODEX_LIFECYCLE_ROOT: root,
        CODEX_APP_SERVER_BIN:
          process.env.CODEX_APP_SERVER_BIN ??
          join(codexRoot(project), "codex-rs/target/debug/codex-app-server"),
        CODEX_HOME: join(root, "owned-home"),
        CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1",
        CODEX_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
      },
    },
  );
  launch.child.stdin.end();
  const { stdout, stderr } = await launch;
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}
await launchHost();
const evidence = join(project, "acceptance-results/lifecycle");
await mkdir(evidence, { recursive: true });
let count = 0,
  finished = false;
for (let attempt = 0; attempt < 1200; attempt++) {
  const results = await readFile(join(root, "host-results.json"), "utf8")
    .then(JSON.parse)
    .catch(() => []);
  if (results.length !== count) {
    for (const result of results.slice(count))
      console.log(`${result.status}: ${result.name}`);
    count = results.length;
  }
  const error = await readFile(join(root, "host-error.txt"), "utf8").catch(
    () => undefined,
  );
  const success = await readFile(join(root, "host-success.txt"), "utf8").catch(
    () => undefined,
  );
  if (error || success) {
    await writeFile(
      join(evidence, "latest-run.json"),
      JSON.stringify(
        { root, count, status: error ? "FAIL" : "PASS", error },
        null,
        2,
      ) + "\n",
    );
    for (const name of await readdir(root))
      if (name.startsWith("host-"))
        await cp(join(root, name), join(evidence, name), { force: true });
    await rm(join(evidence, "logs"), { recursive: true, force: true });
    await cp(join(root, "vscode-data/logs"), join(evidence, "logs"), {
      recursive: true,
      force: true,
    });
    if (error) {
      console.error(error);
      process.exitCode = 1;
    } else
      console.log(
        `All ${count} lifecycle Host API checks passed. Evidence: ${evidence}`,
      );
    finished = true;
    break;
  }
  await new Promise((done) => setTimeout(done, 100));
}
fixture.kill("SIGTERM");
if (!finished) {
  await writeFile(
    join(evidence, "latest-run.json"),
    JSON.stringify(
      { root, count, status: "BLOCKED", reason: "Host test timeout" },
      null,
      2,
    ),
  );
  throw new Error(
    `Extension Host acceptance timed out. Inspect ${root}/vscode-data/logs`,
  );
}
