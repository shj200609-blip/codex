import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { TransportError } from "./errors";

export interface ProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}
export class AppServerProcess extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  constructor(
    private readonly options: ProcessOptions,
    private readonly log: (message: string) => void,
  ) {
    super();
  }
  get stdin(): Writable {
    if (!this.child) throw new TransportError("App Server is not running");
    return this.child.stdin;
  }
  get stdout(): Readable {
    if (!this.child) throw new TransportError("App Server is not running");
    return this.child.stdout;
  }
  async start(): Promise<void> {
    if (this.child) throw new TransportError("App Server is already running");
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      shell: false,
      stdio: "pipe",
    });
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) =>
      this.log(`[stderr] ${chunk.trimEnd()}`),
    );
    child.on("error", (error) => {
      this.emit("failure", new TransportError(error.message));
    });
    child.once("close", (code, signal) => {
      if (this.child === child) this.child = undefined;
      this.log(`App Server exited (code=${code}, signal=${signal})`);
      this.emit("exit", code, signal);
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, 2000);
      child.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.stdin.end();
      child.kill("SIGTERM");
    });
  }
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }
}
