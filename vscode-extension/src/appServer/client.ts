import { EventEmitter } from "node:events";
import type { Transport } from "./transport";
import type {
  Method,
  Params,
  Responses,
  RpcClient,
  NotificationMethod,
  NotificationParams,
} from "./protocol";
import { DisconnectedError, ProtocolError, RpcError } from "./errors";

type Pending = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};
export type ConnectionState = "Connecting" | "Ready" | "Disconnected";
export class AppServerClient extends EventEmitter implements RpcClient {
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private connected = false;
  private ready = false;
  private state: ConnectionState = "Disconnected";
  constructor(
    private readonly transport: Transport,
    private readonly log: (message: string) => void,
    private readonly timeoutMs = 30000,
  ) {
    super();
    transport.on("message", (message) => this.receive(message));
    transport.on("close", (error) => this.disconnect(error));
    transport.on("fault", (error) => {
      this.log(`${error.name}: ${error.message}`);
      this.disconnect(error);
      void this.transport
        .stop()
        .catch((stopError) => this.log(String(stopError)));
    });
  }
  get connectionState(): ConnectionState {
    return this.state;
  }
  private setState(state: ConnectionState): void {
    this.state = state;
    this.emit("state", state);
  }
  async start(): Promise<void> {
    this.setState("Connecting");
    try {
      await this.transport.start();
      this.connected = true;
      await this.request("initialize", {
        clientInfo: {
          name: "codex_changes_review",
          title: "Codex Changes Review",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.notification("initialized");
      this.ready = true;
      this.setState("Ready");
    } catch (error) {
      this.disconnect(
        error instanceof Error ? error : new Error(String(error)),
      );
      await this.transport.stop();
      throw error;
    }
  }
  request<M extends Method>(
    method: M,
    params: Params<M>,
  ): Promise<Responses[M]> {
    if (!this.connected || (!this.ready && method !== "initialize"))
      return Promise.reject(new DisconnectedError("App Server is not ready"));
    const id = this.nextId++;
    return new Promise<Responses[M]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ProtocolError(
            `App Server request timed out: ${method}. Refresh before retrying a review operation.`,
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (result) => resolve(result as Responses[M]),
        reject,
        timer,
      });
      try {
        this.transport.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  notification(method: "initialized"): void {
    if (!this.connected)
      throw new DisconnectedError("App Server is disconnected");
    this.transport.send(JSON.stringify({ method }));
  }
  onNotification<M extends NotificationMethod>(
    method: M,
    listener: (params: NotificationParams<M>) => void,
  ): () => void {
    const event = `notification:${method}`;
    const handler = (params: unknown) =>
      listener(params as NotificationParams<M>);
    this.on(event, handler);
    return () => this.off(event, handler);
  }
  private receive(raw: string): void {
    try {
      const message: unknown = JSON.parse(raw);
      if (!message || typeof message !== "object" || Array.isArray(message))
        throw new ProtocolError("Expected an App Server JSON object");
      const value = message as Record<string, unknown>;
      if (typeof value.method === "string") {
        if ("id" in value) {
          // The shared server routes thread interaction to its producer. Keep this
          // defensive guard for older servers and global requests: a reviewer
          // never grants, denies, or returns an error for producer interaction.
          this.log(
            `Server request left to the producer client: ${value.method}`,
          );
        } else {
          this.emit(`notification:${value.method}`, value.params);
        }
        return;
      }
      if (
        typeof value.id !== "number" ||
        "result" in value === "error" in value
      )
        throw new ProtocolError("Malformed App Server response envelope");
      const pending = this.pending.get(value.id);
      if (!pending) {
        this.log(`Ignored late/unknown response id ${value.id}`);
        return;
      }
      if ("error" in value) {
        const error = value.error as {
          code?: unknown;
          message?: unknown;
          data?: unknown;
        } | null;
        if (
          !error ||
          typeof error.code !== "number" ||
          typeof error.message !== "string"
        )
          throw new ProtocolError("Malformed App Server error");
        this.pending.delete(value.id);
        clearTimeout(pending.timer);
        pending.reject(new RpcError(error.code, error.message, error.data));
      } else {
        this.pending.delete(value.id);
        clearTimeout(pending.timer);
        pending.resolve(value.result);
      }
    } catch (error) {
      const failure =
        error instanceof ProtocolError
          ? error
          : new ProtocolError(
              `Invalid App Server message: ${error instanceof Error ? error.message : String(error)}`,
            );
      this.log(failure.message);
      // Fail outstanding work promptly; callers can reconnect instead of waiting on corrupt frames.
      this.disconnect(failure);
      void this.transport
        .stop()
        .catch((stopError) => this.log(String(stopError)));
    }
  }
  private disconnect(error: Error): void {
    this.connected = false;
    this.ready = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (this.state !== "Disconnected") this.setState("Disconnected");
  }
  async stop(): Promise<void> {
    this.disconnect(new DisconnectedError("App Server connection stopped"));
    await this.transport.stop();
  }
}
