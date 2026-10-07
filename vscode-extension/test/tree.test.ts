import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  hunkPresentation,
  filePresentation,
  setPresentation,
  hunkPreview,
  changeGroupLabel,
} from "../src/changes/changeTreeItems";
import { virtualIdentity, decodeIdentity } from "../src/diff/identity";
import { reference, refKey } from "../src/changes/models";
import { snapshot } from "./fixtures";
test("state labels, ThemeIcon names and context actions follow server decisions", () => {
  const expected = {
    pending: ["Pending", "", true],
    accepted: ["Accepted", "check", false],
    reverted: ["Reverted", "discard", false],
    conflict: ["Conflict", "warning", false],
    unsupported: ["Unsupported", "question", false],
    reviewed: ["Reviewed", "check-all", false],
  } as const;
  for (const [state, [label, icon, enabled]] of Object.entries(expected)) {
    const hunk = snapshot().files[0].hunks[0];
    hunk.state = state as typeof hunk.state;
    const item = hunkPresentation(hunk);
    assert.equal(item.label, "+4 −2");
    assert.equal(item.description, "");
    assert.ok(item.tooltip.includes(label));
    assert.equal(item.icon, icon);
    assert.equal(item.contextValue, `hunk:${state}`);
    assert.equal(item.canAccept, enabled);
    assert.equal(item.canRevert, enabled);
    assert.ok(!item.label.includes("43"));
    assert.match(item.tooltip, /current position/);
  }
});
test("patch previews prefer real added lines, skip context/headers/blank lines and bound Unicode excerpts", () => {
  const hunk = snapshot().files[0].hunks[0];
  hunk.patch =
    "--- a/file\n+++ b/file\n@@ -1,3 +1,4 @@\n context\n-old value\n+   \n+  foo\t= newValue  \n+later";
  assert.equal(hunkPreview(hunk), "foo = newValue");
  hunk.patch = "@@ -1 +0,0 @@\n- removed\tblock\n\\ No newline at end of file";
  assert.equal(hunkPreview(hunk), "removed block");
  hunk.patch = "@@ -0,0 +1 @@\n++++counter;";
  assert.equal(hunkPreview(hunk), "+++counter;");
  hunk.patch = "@@ -0,0 +1 @@\n+" + "😀".repeat(80);
  assert.equal(Array.from(hunkPreview(hunk)).length, 56);
  assert.ok(hunkPreview(hunk).endsWith("…"));
  hunk.patch = "@@ -0,0 +0,0 @@\n";
  assert.equal(hunkPreview(hunk), "");
});
test("file/group rows keep UUIDs and progress in tooltips, with short default descriptions", () => {
  const set = snapshot();
  set.turnId = "01a10f74-cf29-7cf1-b191-e873fdf2324c";
  const file = set.files[0];
  assert.equal(filePresentation(file, "src/a.rs").description, "3 changes");
  file.changeType = "added";
  assert.equal(filePresentation(file, "src/a.rs").description, "Added");
  file.changeType = "deleted";
  assert.equal(filePresentation(file, "src/a.rs").description, "Deleted");
  const second = snapshot();
  second.id = "set-2";
  assert.equal(changeGroupLabel([set], reference(set)), "Changes");
  assert.equal(changeGroupLabel([set, second], reference(second)), "Changes 2");
  assert.equal(setPresentation(set).label, "Changes");
  assert.ok(!setPresentation(set).description.includes("Pending"));
  assert.ok(setPresentation(set).tooltip.includes(set.turnId));
});
test("partial conflict files still offer bulk actions for remaining pending hunks", () => {
  const set = snapshot();
  set.state = set.files[0].state = "conflict";
  set.files[0].hunks[0].state = "conflict";
  assert.equal(
    filePresentation(set.files[0], "a.ts").contextValue,
    "file:conflict:pending",
  );
  assert.equal(setPresentation(set).canRevert, true);
  set.files[0].hunks.forEach((hunk) => (hunk.state = "accepted"));
  assert.equal(filePresentation(set.files[0], "a.ts").canAccept, false);
  set.files[0].unsupportedReason = "Unsupported encoding";
  assert.equal(filePresentation(set.files[0], "a.ts").canRevert, false);
});
test("manifest menus expose review only for pending states, and include all registered commands", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  for (const level of ["Hunk", "File", "All"])
    for (const action of ["accept", "revert"]) {
      const command = `codexChanges.${action}${level}`;
      assert.ok(
        manifest.contributes.commands.some(
          (entry: { command: string }) => entry.command === command,
        ),
      );
      for (const menu of manifest.contributes.menus["view/item/context"].filter(
        (entry: { command: string }) => entry.command === command,
      )) {
        assert.match(menu.when, /pending/);
        assert.match(menu.when, /codexChanges.ready/);
      }
    }
});
test("virtual identities round-trip escaped IDs and stay stable across file/hunk positions", () => {
  const ref = {
    threadId: "thread / #?",
    turnId: "回合",
    changeSetId: "set%/",
    fileId: "file\\?#",
  };
  const identity = virtualIdentity(ref, "baseline");
  assert.deepEqual(decodeIdentity(identity), { ref, side: "baseline" });
  assert.notEqual(identity, virtualIdentity(ref, "current"));
  assert.notEqual(refKey(ref), refKey({ ...ref, hunkId: "hunk" }));
  assert.throws(() => decodeIdentity("[]"));
  const set = snapshot();
  const key = refKey(reference(set));
  set.revision++;
  set.files[0].hunks.reverse();
  assert.equal(refKey(reference(set)), key);
});
