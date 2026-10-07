import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AppServerClient } from "../src/appServer/client";
import { JsonLineDecoder, type Transport } from "../src/appServer/transport";
import {
  RpcError,
  DisconnectedError,
  ProtocolError,
} from "../src/appServer/errors";
class FakeTransport extends EventEmitter implements Transport {
  sent: Record<string, unknown>[] = [];
  async start() {}
  send(raw: string) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.method === "initialize")
      queueMicrotask(() =>
        this.reply({ id: message.id, result: { userAgent: "test" } }),
      );
  }
  reply(message: unknown) {
    this.emit("message", JSON.stringify(message));
  }
  async stop() {
    this.emit("close", new DisconnectedError("closed"));
  }
}
test("initialize handshake, ID tracking, out-of-order responses, errors and subscriptions", async () => {
  const transport = new FakeTransport();
  const client = new AppServerClient(transport, () => {});
  await client.start();
  assert.equal(client.connectionState, "Ready");
  assert.equal(transport.sent[1].method, "initialized");
  const first = client.request("changeSet/read", {
    threadId: "thread",
    turnId: "1",
  });
  const second = client.request("changeSet/read", {
    threadId: "thread",
    turnId: "2",
  });
  transport.reply({ id: transport.sent[3].id, result: { changeSet: null } });
  transport.reply({
    id: transport.sent[2].id,
    error: { code: -32602, message: "unknown turn" },
  });
  await assert.rejects(first, RpcError);
  assert.deepEqual(await second, { changeSet: null });
  let seen = 0;
  const off = client.onNotification("changeSet/created", () => seen++);
  transport.reply({ method: "changeSet/created", params: {} });
  off();
  transport.reply({ method: "changeSet/created", params: {} });
  assert.equal(seen, 1);
  await client.stop();
});
test("process death rejects every pending request promptly", async () => {
  const transport = new FakeTransport();
  const client = new AppServerClient(transport, () => {});
  await client.start();
  const pending = client.request("changeSet/read", {
    threadId: "thread",
    turnId: "turn",
  });
  transport.emit("close", new DisconnectedError("process exited"));
  await assert.rejects(pending, DisconnectedError);
  assert.equal(client.connectionState, "Disconnected");
  await assert.rejects(
    client.request("thread/loaded/list", {}),
    DisconnectedError,
  );
});
test("malformed message rejects pending work, disconnects and does not throw out of the event handler", async () => {
  const transport = new FakeTransport();
  const client = new AppServerClient(transport, () => {});
  await client.start();
  const pending = client.request("thread/loaded/list", {});
  assert.doesNotThrow(() => transport.emit("message", "{broken"));
  await assert.rejects(pending, ProtocolError);
  assert.equal(client.connectionState, "Disconnected");
});
test("timeouts clean pending IDs and ignore a late response", async () => {
  const transport = new FakeTransport();
  const client = new AppServerClient(transport, () => {}, 10);
  await client.start();
  const pending = client.request("thread/loaded/list", {});
  await assert.rejects(pending, /timed out/);
  transport.reply({
    id: transport.sent[2].id,
    result: { data: [], nextCursor: null },
  });
  assert.equal(client.connectionState, "Ready");
  await client.stop();
});
test("review observer leaves broadcast server requests to the producer client", async () => {
  const transport = new FakeTransport();
  const client = new AppServerClient(transport, () => {});
  await client.start();
  transport.reply({
    id: "approval",
    method: "item/commandExecution/requestApproval",
    params: {},
  });
  assert.equal(
    transport.sent.length,
    2,
    "A response here could race the real approval UI",
  );
  await client.stop();
});
test("stdio framing handles multiple lines, CRLF and split UTF-8 code points", () => {
  const lines: string[] = [];
  const decoder = new JsonLineDecoder((line) => lines.push(line));
  const bytes = Buffer.from('{"text":"你好"}\r\n\n{"id":2}\n');
  for (const byte of bytes) decoder.push(Buffer.from([byte]));
  decoder.end();
  assert.deepEqual(lines, ['{"text":"你好"}', '{"id":2}']);
  const incomplete = new JsonLineDecoder(() => {});
  incomplete.push(Buffer.from("{"));
  assert.throws(() => incomplete.end(), ProtocolError);
});
