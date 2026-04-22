import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import type { HistoryEntry } from "@shared/types";
import { InteractionCard } from "../src/components/InteractionCard";
import { I18nProvider } from "../src/i18n/I18nContext";

function renderInteractionCard(): string {
  const originalLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() {
      return "en";
    },
    setItem() {},
    removeItem() {},
    clear() {},
    key() {
      return null;
    },
    length: 0,
  } as Storage;

  const agentEntry: HistoryEntry = {
    role: "agent",
    summary: "Summary body",
    question: "Question body",
    timestamp: 10,
  };

  const userEntry: HistoryEntry = {
    role: "user",
    feedback: "Feedback body",
    timestamp: 11,
  };

  try {
    return renderToStaticMarkup(
      <I18nProvider>
        <InteractionCard
          index={0}
          agentEntry={agentEntry}
          userEntry={userEntry}
          onQuote={() => {}}
          onForward={() => {}}
        />
      </I18nProvider>,
    );
  } finally {
    globalThis.localStorage = originalLocalStorage;
  }
}

test("InteractionCard renders forward actions after quote actions and uses the new forward icon", () => {
  const html = renderInteractionCard();
  const dom = new JSDOM(html);

  const summaryButtons = Array.from(
    dom.window.document.querySelectorAll(".summary-card .entry-section__actions button"),
  ).map((button) => button.getAttribute("title"));
  assert.deepEqual(summaryButtons, ["Copy", "Quote summary", "Forward summary"]);

  const questionButtons = Array.from(
    dom.window.document.querySelectorAll(".question-card .entry-section__actions button"),
  ).map((button) => button.getAttribute("title"));
  assert.deepEqual(questionButtons, ["Copy", "Quote question", "Forward question"]);

  const feedbackButtons = Array.from(
    dom.window.document.querySelectorAll(".feedback-record .entry-section__actions button"),
  ).map((button) => button.getAttribute("title"));
  assert.deepEqual(feedbackButtons, ["Copy", "Quote feedback", "Forward feedback"]);

  const forwardButton = dom.window.document.querySelector('.summary-card .entry-section__actions button[title="Forward summary"]');
  assert.ok(forwardButton);
  assert.match(
    forwardButton.innerHTML,
    /M8 1\.75v6\.5/,
  );
  assert.match(
    forwardButton.innerHTML,
    /M5\.25 4\.5 8 1\.75 10\.75 4\.5/,
  );
  assert.match(
    forwardButton.innerHTML,
    /M4 6\.75v5\.5c0 \.69\.56 1\.25 1\.25 1\.25h5\.5c\.69 0 1\.25-\.56 1\.25-1\.25v-5\.5/,
  );
});
