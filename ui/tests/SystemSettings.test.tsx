import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PredefinedMessagesList,
  type PredefinedMsg,
} from "../src/components/SystemSettings";

test("PredefinedMessagesList renders a copy button for each predefined message", () => {
  const messages: PredefinedMsg[] = [
    { id: "1", text: "first", active: true },
    { id: "2", text: "second", active: false },
  ];

  const html = renderToStaticMarkup(
    <PredefinedMessagesList
      messages={messages}
      onToggle={() => {}}
      onRemove={() => {}}
    />,
  );

  assert.equal((html.match(/system-settings__predefined-copy/g) ?? []).length, 2);
  assert.equal((html.match(/title="Copy"/g) ?? []).length, 2);
});
