import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as deployPanelModule from "../src/components/DeployPanel";
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

test("getDeployStepDisplayName localizes known step ids by locale and falls back for unknown ids", () => {
  const getDeployStepDisplayName = (deployPanelModule as {
    getDeployStepDisplayName?: (step: { id: string; name: string }, locale: "zh" | "en") => string;
  }).getDeployStepDisplayName;

  assert.equal(typeof getDeployStepDisplayName, "function");
  assert.equal(
    getDeployStepDisplayName!({ id: "check_workspace", name: "检查工作区路径是否存在" }, "zh"),
    "检查工作区路径是否存在",
  );
  assert.equal(
    getDeployStepDisplayName!({ id: "check_workspace", name: "检查工作区路径是否存在" }, "en"),
    "Check workspace path",
  );
  assert.equal(
    getDeployStepDisplayName!({ id: "unknown_step", name: "fallback" }, "en"),
    "fallback",
  );
});

test("getDeployStepDisplayDetail translates known Chinese detail fragments in English locale", () => {
  const getDeployStepDisplayDetail = (deployPanelModule as {
    getDeployStepDisplayDetail?: (detail: string | undefined, locale: "zh" | "en") => string | undefined;
  }).getDeployStepDisplayDetail;

  assert.equal(typeof getDeployStepDisplayDetail, "function");
  assert.equal(
    getDeployStepDisplayDetail!(
      "当前 HTTP 进程即为 super-ask server，跳过停止服务",
      "en",
    ),
    "The current HTTP process is the super-ask server, so stopping it is skipped",
  );
  assert.equal(
    getDeployStepDisplayDetail!(
      "/tmp/demo\nAGENTS.md 中未找到 super-ask 标记",
      "en",
    ),
    "/tmp/demo\nAGENTS.md does not contain the super-ask marker",
  );
});
