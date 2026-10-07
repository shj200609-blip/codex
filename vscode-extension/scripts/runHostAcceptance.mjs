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
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(
  join(
    process.platform === "darwin" ? "/private/tmp" : await realpath(tmpdir()),
    "codex-inline-host-",
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
const entry = join(project, "dist/hostAcceptance.js");
await build({
  entryPoints: [join(project, "scripts/hostAcceptance.ts")],
  outfile: entry,
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
const launch = promisify(execFile)(executable, [
  "--user-data-dir",
  join(root, "vscode-data"),
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
  workspace,
]);
launch.child.stdin.end();
const { stdout, stderr } = await launch;
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
const evidence = join(project, "acceptance-results/native-inline");
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
      console.log(`All ${count} Host API checks passed. Evidence: ${evidence}`);
    finished = true;
    break;
  }
  await new Promise((done) => setTimeout(done, 100));
}
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
