import assert from "node:assert/strict";
import { test } from "node:test";
import { SharedReconnect } from "../src/appServer/reconnect";
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("shared reconnect coalesces failures, avoids overlapping attempts and stops on dispose", async () => {
  let attempts = 0,
    release!: () => void;
  const retry = new SharedReconnect(async () => {
    attempts++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  }, [1]);
  retry.disconnected();
  retry.disconnected();
  await tick();
  assert.equal(attempts, 1);
  retry.disconnected();
  retry.disconnected();
  await tick();
  assert.equal(attempts, 1);
  release();
  await tick();
  assert.equal(attempts, 2);
  retry.dispose();
  release();
  await tick();
  retry.disconnected();
  await tick();
  assert.equal(attempts, 2);
});

test("successful reconnect cancels pending retries instead of reloading VS Code", async () => {
  let attempts = 0;
  const retry = new SharedReconnect(async () => {
    attempts++;
  }, [1]);
  retry.disconnected();
  retry.connected();
  await tick();
  assert.equal(attempts, 0);
  retry.disconnected();
  await tick();
  assert.equal(attempts, 1);
  retry.connected();
  retry.dispose();
});
