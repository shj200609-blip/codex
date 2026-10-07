import { test } from "node:test";
import assert from "node:assert/strict";
import type * as vscode from "vscode";

const modules = require("node:module") as {
  _load: (request: string, ...args: unknown[]) => unknown;
};
const load = modules._load;
modules._load = function (request, ...args) {
  return request === "vscode" ? {} : load.call(this, request, ...args);
};
const { hunkLineRange } =
  require("../src/review/hunkDecorations") as typeof import("../src/review/hunkDecorations");
modules._load = load;

test("whole-line frames never include the next line outside Core's hunk", () => {
  for (const line of [0, 4, 28, 39]) {
    for (const length of [0, 20]) {
      const range = {
        start: { line, character: 0 },
        end: { line, character: length },
      };
      const document = {
        lineAt: () => ({
          range,
          rangeIncludingLineBreak: {
            start: range.start,
            end: line === 39 ? range.end : { line: line + 1, character: 0 },
          },
        }),
      } as unknown as vscode.TextDocument;
      assert.equal(hunkLineRange(document, line).end.line, line);
      assert.equal(hunkLineRange(document, line), range);
    }
  }
});
