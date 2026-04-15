import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DeployPanel } from "../src/components/DeployPanel";

test("DeployPanel renders OpenCode as deployable platform and status row", () => {
  const html = renderToStaticMarkup(<DeployPanel />);

  assert.equal((html.match(/OpenCode/g) ?? []).length, 2);
  assert.equal((html.match(/deploy-panel__status-item/g) ?? []).length, 5);
});

test("DeployPanel reuses system settings section titles and descriptions for top-level layout", () => {
  const html = renderToStaticMarkup(<DeployPanel />);

  assert.equal((html.match(/system-settings__section-title/g) ?? []).length, 4);
  assert.equal((html.match(/system-settings__section-desc/g) ?? []).length, 1);
  assert.doesNotMatch(html, /deploy-panel__label/);
  assert.doesNotMatch(html, /deploy-panel__status-title/);
  assert.doesNotMatch(html, /deploy-panel__steps-title/);
});
