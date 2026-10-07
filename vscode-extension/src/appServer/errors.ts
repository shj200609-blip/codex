export class DisconnectedError extends Error {
  readonly name = "DisconnectedError";
}
export class TransportError extends Error {
  readonly name = "TransportError";
}
export class ProtocolError extends Error {
  readonly name = "ProtocolError";
}
export class RpcError extends Error {
  readonly name = "RpcError";
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}
export function isNotFound(error: unknown): boolean {
  // App Server currently uses invalid-params for unknown session/turn identities.
  return (
    error instanceof RpcError &&
    [-32600, -32602].includes(error.code) &&
    /not found|unknown|not loaded|no .*thread|does not exist/i.test(
      error.message,
    )
  );
}
