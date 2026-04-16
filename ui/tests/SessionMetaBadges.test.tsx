import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HistoryEntry } from "@shared/types";
import { InteractionCard } from "../src/components/InteractionCard";
import { RequestStatusBadge, SourceBadge } from "../src/components/SessionMetaBadges";

test("RequestStatusBadge renders acked as delivered instead of cancelled", () => {
  const html = renderToStaticMarkup(<RequestStatusBadge status="acked" />);

  assert.match(html, /Delivered/);
  assert.match(html, /session-tabs__request-status--acked/);
  assert.doesNotMatch(html, /Cancelled/);
});

test("InteractionCard renders delivered tooltip for acked replies", () => {
  const agentEntry: HistoryEntry = {
    role: "agent",
    summary: "summary",
    question: "question",
    timestamp: 1,
  };
  const userEntry: HistoryEntry = {
    role: "user",
    feedback: "feedback",
    timestamp: 2,
  };

  const html = renderToStaticMarkup(
    <InteractionCard index={0} agentEntry={agentEntry} userEntry={userEntry} isAcked />
  );

  assert.match(html, /entry-ack-badge/);
  assert.match(html, /title="Delivered to agent"/);
});

test("InteractionCard renders copy buttons for summary question and feedback", () => {
  const agentEntry: HistoryEntry = {
    role: "agent",
    summary: "summary",
    question: "question",
    timestamp: 1,
  };
  const userEntry: HistoryEntry = {
    role: "user",
    feedback: "feedback",
    timestamp: 2,
  };

  const html = renderToStaticMarkup(
    <InteractionCard index={0} agentEntry={agentEntry} userEntry={userEntry} />
  );

  assert.equal((html.match(/entry-section__copy-btn/g) ?? []).length, 3);
  assert.equal((html.match(/title="Copy"/g) ?? []).length, 3);
});

test("InteractionCard opens markdown links in a new tab by default", () => {
  const agentEntry: HistoryEntry = {
    role: "agent",
    summary: "Read the [docs](https://example.com/docs)",
    timestamp: 1,
  };

  const html = renderToStaticMarkup(<InteractionCard index={0} agentEntry={agentEntry} />);

  assert.match(html, /href="https:\/\/example\.com\/docs"/);
  assert.equal((html.match(/target="_blank"/g) ?? []).length, 1);
  assert.equal((html.match(/rel="noopener noreferrer"/g) ?? []).length, 1);
});

test("InteractionCard renders Mermaid placeholders for summary question and feedback", () => {
  const mermaid = "```mermaid\ngraph TD; A-->B;\n```";
  const agentEntry: HistoryEntry = {
    role: "agent",
    summary: mermaid,
    question: mermaid,
    timestamp: 1,
  };
  const userEntry: HistoryEntry = {
    role: "user",
    feedback: mermaid,
    timestamp: 2,
  };

  const html = renderToStaticMarkup(
    <InteractionCard index={0} agentEntry={agentEntry} userEntry={userEntry} />
  );

  assert.equal((html.match(/class="markdown-mermaid"/g) ?? []).length, 3);
  assert.match(html, /markdown-mermaid__fallback/);
  assert.match(html, /graph TD; A--&gt;B;/);
  assert.equal((html.match(/data-mermaid-source="graph TD; A--&gt;B;"/g) ?? []).length, 3);
});

test("SourceBadge renders OpenCode with dedicated label and style", () => {
  const html = renderToStaticMarkup(<SourceBadge source="opencode" />);

  assert.match(html, /OpenCode/);
  assert.match(html, /session-tabs__source--opencode/);
  assert.doesNotMatch(html, /session-tabs__source--other/);
});
