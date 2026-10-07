import { test } from "node:test";
import assert from "node:assert/strict";
import { locationRange } from "../src/diff/range";
test("live 1-based positions convert to 0-based exclusive editor ranges", () => {
  for (const [startLine, expected] of [
    [1, 0],
    [73, 72],
  ]) {
    assert.deepEqual(
      locationRange(
        { status: "located", kind: "content", startLine, lineCount: 8 },
        100,
        () => 5,
      ),
      {
        startLine: expected,
        startCharacter: 0,
        endLine: expected + 8,
        endCharacter: 0,
      },
    );
  }
});
test("content at EOF ends at the last text column and never indexes beyond the document", () => {
  const calls: number[] = [];
  assert.deepEqual(
    locationRange(
      { status: "located", kind: "content", startLine: 3, lineCount: 2 },
      4,
      (line) => {
        calls.push(line);
        return 7;
      },
    ),
    { startLine: 2, startCharacter: 0, endLine: 3, endCharacter: 7 },
  );
  assert.deepEqual(calls, [3]);
});
test("deletion anchors handle BOF, middle, EOF and empty file without illegal line access", () => {
  for (const [startLine, documentLines, expected] of [
    [1, 10, 0],
    [5, 10, 4],
    [11, 10, 9],
    [1, 1, 0],
    [1, 0, 0],
  ]) {
    const range = locationRange(
      { status: "located", kind: "deletionAnchor", startLine, lineCount: 0 },
      documentLines,
      () => {
        throw new Error("Anchor must not inspect a text line");
      },
    );
    assert.deepEqual(range, {
      startLine: expected,
      startCharacter: 0,
      endLine: expected,
      endCharacter: 0,
    });
  }
});
test("presence-only hunks open without a forced selection", () => {
  assert.equal(
    locationRange(
      { status: "located", kind: "filePresence", startLine: 1, lineCount: 0 },
      1,
      () => 0,
    ),
    undefined,
  );
});
