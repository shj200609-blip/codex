import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import WebSocket from "ws";
import { AppServerProcess } from "./process";
import { DisconnectedError, ProtocolError, TransportError } from "./errors";

export interface Transport {
  start(): Promise<void>;
  send(message: string): void;
  stop(): Promise<void>;
  on(event: "message", listener: (message: string) => void): this;
  on(event: "close" | "fault", listener: (error: Error) => void): this;
}
// Explicit shared setup errors stay disconnected; they never launch private Core.
export class UnavailableTransport extends EventEmitter implements Transport {
  constructor(private readonly error: Error) {
    super();
  }
  async start(): Promise<void> {
    throw this.error;
  }
  send(_message: string): void {
    throw this.error;
  }
  async stop(): Promise<void> {}
}
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

// The server uses newline-delimited JSON on stdio, not Content-Length framing.
export class JsonLineDecoder {
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  constructor(private readonly message: (line: string) => void) {}
  push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, "");
      this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES)
        throw new ProtocolError("App Server message exceeds 64 MiB");
      if (line.trim()) this.message(line);
    }
    if (Buffer.byteLength(this.buffer) > MAX_MESSAGE_BYTES)
      throw new ProtocolError("Unterminated App Server message exceeds 64 MiB");
  }
  end(): void {
    if ((this.buffer + this.decoder.end()).trim())
      throw new ProtocolError("App Server closed with an incomplete JSON line");
  }
}

export class StdioTransport extends EventEmitter implements Transport {
  private alive = false;
  constructor(readonly process: AppServerProcess) {
    super();
  }
  async start(): Promise<void> {
    this.process.on("failure", (error: Error) => this.emit("fault", error));
    this.process.on("exit", (code, signal) => {
      this.alive = false;
      this.emit(
        "close",
        new DisconnectedError(`App Server exited (${code ?? signal})`),
      );
    });
    await this.process.start();
    this.alive = true;
    const decoder = new JsonLineDecoder((line) => this.emit("message", line));
    this.process.stdout.on("data", (chunk: Buffer) => {
      try {
        decoder.push(chunk);
      } catch (error) {
        this.emit("fault", error);
      }
    });
    this.process.stdout.on("end", () => {
      try {
        decoder.end();
      } catch (error) {
        this.emit("fault", error);
      }
    });
    this.process.stdin.on("error", (error) =>
      this.emit("fault", new TransportError(error.message)),
    );
  }
  send(message: string): void {
    if (!this.alive) throw new DisconnectedError("App Server is disconnected");
    this.process.stdin.write(`${message}\n`);
  }
  async stop(): Promise<void> {
    this.alive = false;
    await this.process.stop();
  }
}

export class WebSocketTransport extends EventEmitter implements Transport {
  private socket?: WebSocket;
  constructor(private readonly url: string) {
    super();
  }
  async start(): Promise<void> {
    const url = new URL(this.url);
    // This MVP reviews local filesystem URIs and deliberately has no remote/auth UI.
    if (
      url.protocol !== "ws:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password
    ) {
      throw new TransportError(
        "Use an unauthenticated loopback ws:// App Server for this MVP",
      );
    }
    const socket = (this.socket = new WebSocket(url, {
      maxPayload: MAX_MESSAGE_BYTES,
      handshakeTimeout: 10000,
    }));
    socket.on("message", (data, binary) => {
      if (binary) {
        this.emit(
          "fault",
          new ProtocolError("App Server sent a binary WebSocket message"),
        );
        return;
      }
      this.emit("message", data.toString());
    });
    socket.on("error", (error) =>
      this.emit("fault", new TransportError(error.message)),
    );
    socket.on("close", (code) =>
      this.emit(
        "close",
        new DisconnectedError(`App Server WebSocket closed (${code})`),
      ),
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
  }
  send(message: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN)
      throw new DisconnectedError("App Server is disconnected");
    this.socket.send(message, (error) => {
      if (error) this.emit("fault", new TransportError(error.message));
    });
  }
  async stop(): Promise<void> {
    this.socket?.terminate();
    this.socket = undefined;
  }
}
