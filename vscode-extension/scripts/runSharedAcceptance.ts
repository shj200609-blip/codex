import { codexRoot } from "./paths.mjs";
// Real Rust CLI/TUI + shared App Server + real VS Code extension, deterministic local model.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  cp,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { build } from "esbuild";
import { AppServerClient } from "../src/appServer/client";
import { WebSocketTransport } from "../src/appServer/transport";
import type { ChangeSet } from "../src/appServer/protocol";

async function main() {
  const project = resolve(__dirname, "..");
  const binary =
    process.env.CODEX_CLI_BIN ??
    resolve(codexRoot(project), "codex-rs/target/debug/codex");
  const root = await mkdtemp("/private/tmp/codex-shared-cli-");
  const workspaceA = join(root, "project-a"),
    workspaceB = join(root, "project-b"),
    home = join(root, "home");
  const artifacts = join(project, "acceptance-results/shared-cli");
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, "running-root.txt"), root);
  const children: ChildProcess[] = [];
  const logs: string[] = [];
  const checks: string[] = [];
  const terminals: Terminal[] = [];
  const check = (name: string) => {
    checks.push(name);
    console.log(`PASS: ${name}`);
  };
  const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
  async function waitFor<T>(
    fn: () => T | undefined | Promise<T | undefined>,
    timeout = 90000,
  ): Promise<T> {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      for (const side of ["a", "b"]) {
        const error = await readFile(
          join(root, `host-${side}-error`),
          "utf8",
        ).catch(() => undefined);
        if (error) throw new Error(error);
      }
      const value = await fn();
      if (value !== undefined) return value;
      await delay(100);
    }
    throw new Error(`Acceptance timeout; evidence: ${root}`);
  }
  async function freePort() {
    const listener = createTcpServer();
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((done) => listener.close(() => done()));
    return port;
  }
  class Terminal {
    process: ChildProcess;
    output = "";
    pid?: number;
    exit?: number;
    constructor(cwd: string, args: string[], endpoint: string | undefined) {
      terminals.push(this);
      this.process = spawn(
        "python",
        [join(project, "scripts/cliPty.py"), binary, ...args],
        {
          cwd,
          env: {
            ...process.env,
            ...env,
            ...(endpoint ? { CODEX_APP_SERVER_URL: endpoint } : {}),
            TERM: "xterm-256color",
          },
        },
      );
      children.push(this.process);
      createInterface({ input: this.process.stdout! }).on("line", (line) => {
        const message = JSON.parse(line);
        if (message.output) {
          this.output += Buffer.from(message.output, "base64").toString();
          void writeFile(
            join(root, `cli-${cwd.endsWith("project-a") ? "a" : "b"}.live.log`),
            this.output,
          );
        }
        if (message.pid) this.pid = message.pid;
        if (message.exit !== undefined) this.exit = message.exit;
      });
      this.process.stderr!.on("data", (chunk) => logs.push(`PTY: ${chunk}`));
    }
    send(input: string) {
      this.process.stdin!.write(JSON.stringify({ input }) + "\n");
    }
    async submit(text: string) {
      this.send(text);
      // Let TUI paste-burst detection finish before the distinct Enter keystroke.
      await delay(250);
      this.send("\r");
    }
    stop() {
      if (this.exit === undefined) this.process.stdin!.write('{"stop":true}\n');
    }
  }
  delete process.env.CODEX_APP_SERVER_URL;
  const env = {
    CODEX_HOME: home,
    CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1",
    CODEX_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
  };
  const initial =
    Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
  for (const cwd of [workspaceA, workspaceB]) {
    await mkdir(join(cwd, "src"), { recursive: true });
    await mkdir(join(cwd, ".vscode"));
    await writeFile(join(cwd, "src/a.rs"), initial);
    await writeFile(join(cwd, "src/b.rs"), initial);
  }
  await mkdir(home);
  const patch = (file: string) =>
    [
      "*** Begin Patch",
      `*** Update File: ${file}`,
      "@@",
      " line-4",
      "-line-5",
      "+first-change",
      " line-6",
      "@@",
      " line-27",
      "-line-28",
      "+second-change",
      " line-29",
      "*** End Patch",
      "",
    ].join("\n");
  const counts = new Map<string, number>();
  const modelRequests: unknown[] = [];
  const model = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    modelRequests.push(body);
    const structured = body.text?.format?.type === "json_schema";
    const users = body.input.filter((item: any) => item.role === "user");
    const prompt = JSON.stringify(users.at(-1));
    const step = counts.get(prompt) ?? 0;
    counts.set(prompt, step + 1);
    const approval = prompt.includes("approval ownership");
    const interrupt = !structured && prompt.includes("interrupt check");
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (value: unknown) =>
      response.write(`data: ${JSON.stringify(value)}\n\n`);
    send({
      type: "response.created",
      response: { id: `response-${modelRequests.length}` },
    });
    if (interrupt) {
      send({
        type: "response.output_item.added",
        item: { type: "message", role: "assistant", id: "answer", content: [] },
      });
      send({
        type: "response.output_text.delta",
        item_id: "answer",
        delta: "Waiting for interrupt",
      });
      return; // The CLI interrupts this actual running turn.
    }
    if (
      !structured &&
      !prompt.includes("local regression") &&
      (step === 0 || (!approval && step === 1))
    ) {
      const args = approval
        ? {
            cmd: "printf shared-producer-approved",
            sandbox_permissions: "require_escalated",
            justification: "Shared CLI approval ownership check",
          }
        : {
            cmd:
              step === 0
                ? "printf shared-tool-output"
                : `apply_patch <<'EOF'\n${patch(prompt.includes("src/b.rs") ? "src/b.rs" : "src/a.rs")}EOF\n`,
          };
      send({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: `tool-${modelRequests.length}`,
          name: "exec_command",
          arguments: JSON.stringify(args),
        },
      });
    } else {
      const answer = structured
        ? JSON.stringify({ title: "Shared CLI workspace" })
        : "Shared CLI streaming answer";
      send({
        type: "response.output_item.added",
        item: { type: "message", role: "assistant", id: "answer", content: [] },
      });
      send({
        type: "response.output_text.delta",
        item_id: "answer",
        delta: answer,
      });
      send({
        type: "response.output_item.done",
        item: {
          type: "message",
          role: "assistant",
          id: "answer",
          content: [{ type: "output_text", text: answer }],
        },
      });
    }
    send({
      type: "response.completed",
      response: {
        id: `response-${modelRequests.length}`,
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
      },
    });
    response.end();
  });
  await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
  const modelPort = (model.address() as { port: number }).port;
  await writeFile(
    join(home, "config.toml"),
    `model = "mock-model"\nmodel_provider = "mock"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\ncheck_for_update_on_startup = false\n[features]\nshell_snapshot = false\n[model_providers.mock]\nname = "Local shared acceptance model"\nbase_url = "http://127.0.0.1:${modelPort}/v1"\nwire_api = "responses"\nsupports_websockets = false\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[projects."${workspaceA}"]\ntrust_level = "trusted"\n[projects."${workspaceB}"]\ntrust_level = "trusted"\n`,
  );
  let observer: AppServerClient | undefined;
  let terminalA: Terminal | undefined, terminalB: Terminal | undefined;
  const notifications: any[] = [];
  const serverRequests: any[] = [];
  try {
    const port = await freePort(),
      url = `ws://127.0.0.1:${port}`;
    const server = spawn(binary, ["app-server", "--listen", url], {
      cwd: root,
      env: { ...process.env, ...env },
    });
    children.push(server);
    server.stderr!.on("data", (chunk) => logs.push(String(chunk)));
    await waitFor(async () => {
      const transport = new WebSocketTransport(url);
      const candidate = new AppServerClient(transport, (line) =>
        logs.push(line),
      );
      try {
        await candidate.start();
        transport.on("message", (raw) => {
          const message = JSON.parse(raw);
          if (message.method && "id" in message) serverRequests.push(message);
          else if (message.method) {
            notifications.push(message);
            if (
              message.method === "thread/started" &&
              !message.params.thread.ephemeral
            ) {
              void candidate
                .request("thread/resume", {
                  threadId: message.params.thread.id,
                  excludeTurns: true,
                })
                .catch((error) =>
                  logs.push(`Observer subscription: ${String(error)}`),
                );
            }
          }
        });
        observer = candidate;
        return true;
      } catch {
        await candidate.stop();
        return undefined;
      }
    });
    await writeFile(
      join(root, "state.json"),
      JSON.stringify({ url, workspaceA, workspaceB }),
    );
    for (const cwd of [workspaceA, workspaceB])
      await writeFile(
        join(cwd, ".vscode/settings.json"),
        JSON.stringify({
          "codexChanges.connectionMode": "websocket",
          "codexChanges.websocketUrl": url,
          "codexChanges.inlineReview": true,
          "editor.codeLens": true,
          "diffEditor.codeLens": true,
        }),
      );
    await build({
      entryPoints: [join(project, "scripts/sharedHostAcceptance.ts")],
      outfile: join(project, "dist/sharedHostAcceptance.js"),
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["vscode"],
    });
    const anchor = join(root, "ui-anchor");
    await mkdir(anchor);
    const switchingWorkspace = join(root, "switching.code-workspace");
    await writeFile(
      switchingWorkspace,
      JSON.stringify({
        folders: [{ path: anchor }, { path: workspaceA }],
        settings: {
          "codexChanges.connectionMode": "websocket",
          "codexChanges.websocketUrl": url,
          "codexChanges.inlineReview": true,
          "editor.codeLens": true,
          "diffEditor.codeLens": true,
        },
      }),
    );
    async function launchHost(side: string, cwd: string) {
      // VS Code identifies development windows by extension path, even with
      // separate user-data-dir. Give each host an isolated built copy.
      const developmentPath = join(root, `reviewer-${side}`);
      await mkdir(developmentPath);
      for (const name of ["package.json", "dist", "resources"])
        await cp(join(project, name), join(developmentPath, name), {
          recursive: true,
        });
      const processHost = spawn(
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
        [
          "--user-data-dir",
          join(root, `vscode-${side}`),
          "--extensions-dir",
          join(root, `extensions-${side}`),
          "--extensionDevelopmentPath",
          developmentPath,
          "--extensionTestsPath",
          join(developmentPath, "dist/sharedHostAcceptance.js"),
          "--disable-extensions",
          "--disable-workspace-trust",
          "--skip-welcome",
          "--skip-release-notes",
          "--new-window",
          side === "a" ? switchingWorkspace : cwd,
        ],
        {
          env: {
            ...process.env,
            CODEX_SHARED_ACCEPTANCE_ROOT: root,
            CODEX_SHARED_ACCEPTANCE_SIDE: side,
          },
        },
      );
      children.push(processHost);
      processHost.stderr!.on("data", (chunk) =>
        logs.push(`HOST ${side}: ${chunk}`),
      );
      processHost.stdout!.on("data", (chunk) =>
        logs.push(`HOST ${side}: ${chunk}`),
      );
    }
    await launchHost("a", workspaceA);
    await waitFor(() =>
      readFile(join(root, "host-a-ready"), "utf8").catch(() => undefined),
    );
    terminalA = new Terminal(
      workspaceA,
      ["--remote", url, "--no-alt-screen", "modify src/a.rs in two places"],
      undefined,
    );
    const sets = () =>
      notifications
        .filter((n) => n.method === "changeSet/created")
        .map((n) => n.params.changeSet as ChangeSet);
    const first = await waitFor(() =>
      sets().find((set) =>
        set.files.some((file) => file.path.endsWith("/project-a/src/a.rs")),
      ),
    );
    assert.equal(first.files[0].hunks.length, 2);
    const uiRefs = JSON.parse(
      await waitFor(() =>
        readFile(join(root, "host-a-reviewed.json"), "utf8").catch(
          () => undefined,
        ),
      ),
    );
    assert.equal(uiRefs[0].threadId, first.threadId);
    const content = await readFile(join(workspaceA, "src/a.rs"), "utf8");
    assert.ok(
      content.includes("first-change") &&
        !content.includes("second-change") &&
        content.includes("line-28"),
    );
    await waitFor(() =>
      terminalA!.output.includes("Shared CLI streaming answer")
        ? true
        : undefined,
    );
    check(
      "CLI streaming → server apply_patch → live native VS Code lenses → Accept/Revert correct filesystem; same thread ID",
    );
    await terminalA.submit("modify src/b.rs");
    const second = await waitFor(() =>
      sets().find((set) =>
        set.files.some((file) => file.path.endsWith("/project-a/src/b.rs")),
      ),
    );
    assert.equal(second.threadId, first.threadId);
    assert.notEqual(second.turnId, first.turnId);
    check(
      "Second CLI turn creates a distinct ChangeSet in the same server-owned thread",
    );
    await waitFor(() =>
      notifications.filter(
        (n) =>
          n.method === "turn/completed" && n.params.threadId === first.threadId,
      ).length >= 2
        ? true
        : undefined,
    );
    await terminalA.submit("approval ownership check");
    await waitFor(() =>
      /Yes, proceed|Would you like|approve this command/.test(terminalA!.output)
        ? true
        : undefined,
    );
    assert.equal(
      serverRequests.length,
      0,
      "The observer must not receive interactive requests",
    );
    assert.ok(
      !notifications.some(
        (n) =>
          n.method === "turn/completed" &&
          n.params.turn.items?.some((i: any) =>
            i.aggregatedOutput?.includes("shared-producer-approved"),
          ),
      ),
    );
    terminalA.send("\r");
    await waitFor(() =>
      notifications.some(
        (n) =>
          n.method === "item/completed" &&
          n.params.item.aggregatedOutput?.includes("shared-producer-approved"),
      )
        ? true
        : undefined,
    );
    await waitFor(() =>
      notifications.filter(
        (n) =>
          n.method === "turn/completed" && n.params.threadId === first.threadId,
      ).length >= 3
        ? true
        : undefined,
    );
    check(
      "Actual CLI approval prompt; CLI approves; command resumes; observer receives zero server requests",
    );
    // Launch B via the single environment variable entry point while A remains alive.
    await launchHost("b", workspaceB);
    await waitFor(() =>
      readFile(join(root, "host-b-ready"), "utf8").catch(() => undefined),
    );
    terminalB = new Terminal(
      workspaceB,
      ["--no-alt-screen", "project-b modify src/a.rs in two places"],
      url,
    );
    const third = await waitFor(() =>
      sets().find((set) =>
        set.files.some((file) => file.path.endsWith("/project-b/src/a.rs")),
      ),
    );
    assert.notEqual(third.threadId, first.threadId);
    await writeFile(join(root, "check-isolation"), "check");
    const hostA = JSON.parse(
      await waitFor(() =>
        readFile(join(root, "host-a-success.json"), "utf8").catch(
          () => undefined,
        ),
      ),
    );
    const hostB = JSON.parse(
      await waitFor(() =>
        readFile(join(root, "host-b-success.json"), "utf8").catch(
          () => undefined,
        ),
      ),
    );
    assert.equal(hostB.refs[0].threadId, third.threadId);
    check(
      "Two simultaneous CLI producers; actual VS Code A/B isolation and switching A to B without copying IDs",
    );
    await terminalA.submit("interrupt check");
    await waitFor(() =>
      // Ratatui may move the cursor instead of writing the space between words.
      terminalA!.output.includes("Waiting") &&
      terminalA!.output.includes("for interrupt") &&
      notifications.some(
        (n) =>
          n.method === "item/agentMessage/delta" &&
          n.params.threadId === first.threadId &&
          n.params.delta === "Waiting for interrupt",
      )
        ? true
        : undefined,
    );
    terminalA.send("\x03");
    await waitFor(() =>
      notifications.some(
        (n) =>
          n.method === "turn/completed" &&
          n.params.threadId === first.threadId &&
          n.params.turn.status === "interrupted",
      )
        ? true
        : undefined,
    );
    check("CLI Ctrl+C interrupts the shared server turn");
    const loaded = await observer!.request("thread/loaded/list", {
      limit: 100,
    });
    // The existing TUI also creates server-owned ephemeral threads for titles.
    // They are helper work in the same server, not hidden local producer sessions.
    const loadedMetadata = await Promise.all(
      loaded.data.map((threadId) =>
        observer!.request("thread/read", { threadId, includeTurns: false }),
      ),
    );
    assert.deepEqual(
      new Set(
        loadedMetadata
          .filter((r) => !r.thread.ephemeral)
          .map((r) => r.thread.id),
      ),
      new Set([first.threadId, third.threadId]),
    );
    const processRows = execFileSync("/bin/ps", ["-axo", "pid,ppid,command"], {
      encoding: "utf8",
    });
    const cliChildServers = processRows.split("\n").filter((row) => {
      const match = row.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      return (
        match &&
        [terminalA!.pid, terminalB!.pid].includes(Number(match[2])) &&
        /app-server/.test(match[3])
      );
    });
    assert.equal(cliChildServers.length, 0);
    await terminalA.submit("/quit");
    await terminalB.submit("/quit");
    await waitFor(() =>
      terminalA!.exit !== undefined && terminalB!.exit !== undefined
        ? true
        : undefined,
    );
    await observer!.request("thread/loaded/list", { limit: 100 });
    assert.equal(server.exitCode, null);
    check(
      "Only two main producer threads (title helpers also server-owned), no CLI child app-server; CLI exit leaves shared server alive",
    );
    const completedBeforeResume = notifications.filter(
      (n) =>
        n.method === "turn/completed" && n.params.threadId === first.threadId,
    ).length;
    const resumed = new Terminal(
      workspaceA,
      [
        "--remote",
        url,
        "--no-alt-screen",
        "resume",
        first.threadId,
        "local regression resume check",
      ],
      undefined,
    );
    await waitFor(() => {
      if (resumed.exit !== undefined)
        throw new Error(`CLI resume failed: ${resumed.output.slice(-3000)}`);
      return notifications.filter(
        (n) =>
          n.method === "turn/completed" && n.params.threadId === first.threadId,
      ).length > completedBeforeResume
        ? true
        : undefined;
    });
    await resumed.submit("/quit");
    await waitFor(() => (resumed.exit !== undefined ? true : undefined));
    check(
      "New CLI connection resumes the same server thread and becomes its producer after the previous CLI exits",
    );
    const failed = new Terminal(
      workspaceA,
      ["--remote", "ws://127.0.0.1:1", "--no-alt-screen"],
      undefined,
    );
    await waitFor(() => (failed.exit !== undefined ? true : undefined));
    assert.match(failed.output, /Unable to connect to shared Codex server/);
    check(
      "Explicit connection failure is clear and never silently falls back to local Core",
    );
    const local = new Terminal(
      workspaceA,
      ["--no-daemon", "--no-alt-screen", "local regression check"],
      undefined,
    );
    await waitFor(() =>
      local.output.includes("Shared CLI streaming answer") ? true : undefined,
    );
    await local.submit("/quit");
    await waitFor(() => (local.exit !== undefined ? true : undefined));
    check(
      "Existing local TUI backend still runs normally without a shared endpoint",
    );
    const result = {
      status: "PASS",
      root,
      model: "deterministic local Responses SSE",
      checks,
      threadA: first.threadId,
      threadB: third.threadId,
      turns: [first.turnId, second.turnId, third.turnId],
      observerServerRequests: serverRequests.length,
      hostA,
      hostB,
    };
    await writeFile(
      join(artifacts, "latest-run.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    await writeFile(
      join(artifacts, "latest-run.json"),
      JSON.stringify(
        {
          status: "FAIL",
          root,
          checks,
          error: String(error instanceof Error ? error.stack : error),
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    for (const terminal of terminals) terminal.stop();
    await observer?.stop();
    for (const child of children)
      if (child.exitCode === null) child.kill("SIGTERM");
    model.closeAllConnections();
    model.close();
    await writeFile(join(artifacts, "cli-a.ansi.log"), terminalA?.output ?? "");
    await writeFile(join(artifacts, "cli-b.ansi.log"), terminalB?.output ?? "");
    await writeFile(join(artifacts, "server-host.log"), logs.join("\n"));
    await writeFile(
      join(artifacts, "notifications.json"),
      JSON.stringify(notifications, null, 2),
    );
    await writeFile(
      join(artifacts, "model-requests.json"),
      JSON.stringify(modelRequests, null, 2),
    );
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
