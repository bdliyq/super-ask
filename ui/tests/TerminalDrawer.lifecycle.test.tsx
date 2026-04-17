import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { TerminalDrawer } from "../src/components/TerminalDrawer";

const hooksState = vi.hoisted(() => ({
  terminalMount: vi.fn<(id: symbol) => void>(),
  terminalUnmount: vi.fn<(id: symbol) => void>(),
  wsMount: vi.fn<(id: symbol) => void>(),
  wsUnmount: vi.fn<(id: symbol) => void>(),
  wsOptions: vi.fn(),
}));

vi.mock("../src/i18n", () => ({
  useI18n: () => ({ locale: "en" }),
}));

vi.mock("../src/hooks/useTerminal", async () => {
  const React = await import("react");
  return {
    useTerminal: () => {
      const idRef = React.useRef(Symbol("terminal"));
      const containerRef = React.useRef<HTMLDivElement | null>(null);
      React.useEffect(() => {
        hooksState.terminalMount(idRef.current);
        return () => hooksState.terminalUnmount(idRef.current);
      }, []);
      return {
        containerRef,
        write: vi.fn(),
        focus: vi.fn(),
        dispose: vi.fn(),
        clear: vi.fn(),
        readSize: () => ({ cols: 80, rows: 24 }),
      };
    },
  };
});

vi.mock("../src/hooks/useTerminalWs", async () => {
  const React = await import("react");
  return {
    useTerminalWs: (options: unknown) => {
      const idRef = React.useRef(Symbol("ws"));
      hooksState.wsOptions(options);
      React.useEffect(() => {
        hooksState.wsMount(idRef.current);
        return () => hooksState.wsUnmount(idRef.current);
      }, []);
      return {
        connected: true,
        error: null,
        send: vi.fn(),
        sendResize: vi.fn(),
        onOutput: React.useRef<((data: string) => void) | null>(null),
        onSessionChange: React.useRef<(() => void) | null>(null),
      };
    },
  };
});

describe("TerminalDrawer lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function renderDrawer(
    props: React.ComponentProps<typeof TerminalDrawer>,
  ): Promise<void> {
    await act(async () => {
      root.render(<TerminalDrawer {...props} />);
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("keeps terminal core mounted when drawer closes", async () => {
    await renderDrawer({
      open: true,
      sessionId: "session-a",
      workspaceRoot: "/tmp/workspace-a",
    });

    expect(container.querySelector(".terminal-drawer__body")).not.toBeNull();
    expect(hooksState.terminalMount).toHaveBeenCalledTimes(1);

    await renderDrawer({
      open: false,
      sessionId: "session-a",
      workspaceRoot: "/tmp/workspace-a",
    });

    expect(container.querySelector(".terminal-drawer__body")).not.toBeNull();
    expect(hooksState.terminalUnmount).not.toHaveBeenCalled();
    expect(hooksState.wsUnmount).not.toHaveBeenCalled();
  });

  it("remounts terminal core when switching sessions while open", async () => {
    await renderDrawer({
      open: true,
      sessionId: "session-a",
      workspaceRoot: "/tmp/workspace-a",
    });

    const firstTerminalId = hooksState.terminalMount.mock.calls[0]?.[0];
    const firstWsId = hooksState.wsMount.mock.calls[0]?.[0];

    await renderDrawer({
      open: true,
      sessionId: "session-b",
      workspaceRoot: "/tmp/workspace-b",
    });

    expect(hooksState.terminalUnmount).toHaveBeenCalledWith(firstTerminalId);
    expect(hooksState.wsUnmount).toHaveBeenCalledWith(firstWsId);
    expect(hooksState.terminalMount).toHaveBeenCalledTimes(2);
    expect(hooksState.wsMount).toHaveBeenCalledTimes(2);
  });

  it("reuses terminal core when reopening the same session", async () => {
    await renderDrawer({
      open: true,
      sessionId: "session-a",
      workspaceRoot: "/tmp/workspace-a",
    });

    const firstTerminalId = hooksState.terminalMount.mock.calls[0]?.[0];
    const firstWsId = hooksState.wsMount.mock.calls[0]?.[0];

    await renderDrawer({
      open: false,
      sessionId: "session-a",
      workspaceRoot: "/tmp/workspace-a",
    });

    await renderDrawer({
      open: true,
      sessionId: "session-a",
      workspaceRoot: "/tmp/workspace-a",
    });

    expect(hooksState.terminalUnmount).not.toHaveBeenCalled();
    expect(hooksState.wsUnmount).not.toHaveBeenCalled();
    expect(hooksState.terminalMount).toHaveBeenCalledTimes(1);
    expect(hooksState.wsMount).toHaveBeenCalledTimes(1);
    expect(hooksState.terminalMount.mock.calls[0]?.[0]).toBe(firstTerminalId);
    expect(hooksState.wsMount.mock.calls[0]?.[0]).toBe(firstWsId);
  });
});
