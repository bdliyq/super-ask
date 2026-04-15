import assert from "node:assert/strict";
import test from "node:test";
import { resolveInitialView } from "../src/App";

test("resolveInitialView restores settings view only for persisted settings", () => {
  assert.equal(resolveInitialView("settings"), "settings");
  assert.equal(resolveInitialView("chat"), "chat");
  assert.equal(resolveInitialView("unexpected"), "chat");
  assert.equal(resolveInitialView(null), "chat");
});
