import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  readRegistration,
  writeRegistration,
  validateEndpoint,
} from "../src/sharedIde/registration";
import { updateJsoncSetting } from "../scripts/jsoncSetting";
import ts from "typescript";

test("persistent IDE registration survives reopening and preserves the original utility CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "shared IDE's profile "));
  try {
    const fork = join(root, "fork"),
      utility = join(root, "original");
    await writeFile(
      fork,
      '#!/usr/bin/env node\nconsole.log(JSON.stringify({owner:"shared",args:process.argv.slice(2)}));\n',
      { mode: 0o700 },
    );
    await writeFile(
      utility,
      '#!/usr/bin/env node\nconsole.log(JSON.stringify({owner:"original",args:process.argv.slice(2)}));\n',
      { mode: 0o700 },
    );
    const registration = {
      version: 1 as const,
      endpoint: "ws://127.0.0.1:4510/",
      forkExecutable: fork,
      utilityExecutable: utility,
      wrapperPath: join(root, "codex-shared-ide"),
    };
    await writeRegistration(registration);
    const restored = await readRegistration(registration.wrapperPath);
    assert.deepEqual(restored, registration);
    // A stale workspace review URL is not part of producer registration.
    assert.equal(restored!.endpoint, "ws://127.0.0.1:4510/");
    const run = (args: string[]) =>
      JSON.parse(
        execFileSync(registration.wrapperPath, args, { encoding: "utf8" }),
      );
    assert.deepEqual(
      run([
        "-c",
        "features.code_mode_host=true",
        "app-server",
        "--analytics-default-enabled",
      ]),
      {
        owner: "shared",
        args: ["--remote", registration.endpoint, "app-server", "proxy"],
      },
    );
    for (const args of [
      ["--version"],
      ["stdio-to-uds", "/tmp/socket"],
      ["app-server", "generate-ts", "--out", "/tmp/types"],
      ["exec", "app-server"],
    ])
      assert.deepEqual(run(args), { owner: "original", args });
    await writeFile(join(root, "connection.json"), "broken");
    await assert.rejects(
      readRegistration(registration.wrapperPath),
      /Unable to read shared IDE connection/,
    );
    // Explicit shared mode cannot fall back to a private server on corrupt setup.
    assert.equal(await readRegistration(utility), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one-time settings update preserves comments, nested settings and unrelated values", () => {
  for (const source of [
    "{}",
    '{\n  // retained comment\n  "editor.fontSize": 17,\n}',
    '{ "nested": { "chatgpt.cliExecutable": "nested", "array": [1,2,3] } /* retained */ }',
    '{ "chatgpt.cliExecutable": "original", // retained\n "other": "comma, }" }',
  ]) {
    const result = updateJsoncSetting(
      source,
      "chatgpt.cliExecutable",
      "/path with spaces/producer",
    );
    const parsed = ts.parseConfigFileTextToJson("settings.json", result);
    assert.equal(parsed.error, undefined);
    assert.equal(
      parsed.config["chatgpt.cliExecutable"],
      "/path with spaces/producer",
    );
    if (source.includes("retained")) assert(result.includes("retained"));
    const before = ts.parseConfigFileTextToJson("settings.json", source).config;
    delete before["chatgpt.cliExecutable"];
    delete parsed.config["chatgpt.cliExecutable"];
    assert.deepEqual(parsed.config, before);
  }
  assert.throws(() => updateJsoncSetting("{broken", "key", "value"));
  assert.throws(
    () => updateJsoncSetting('{"key":"a","key":"b"}', "key", "value"),
    /Duplicate/,
  );
});

test("shared registration rejects external endpoints and embedded credentials", () => {
  for (const url of [
    "ws://example.com:4510",
    "ws://user:password@127.0.0.1:4510",
    "http://127.0.0.1:4510",
  ])
    assert.throws(() => validateEndpoint(url));
  assert.equal(validateEndpoint("ws://127.0.0.1:4510"), "ws://127.0.0.1:4510/");
});
