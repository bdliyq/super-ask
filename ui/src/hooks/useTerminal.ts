import { useCallback, useEffect, useRef, type RefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

export interface UseTerminalOptions {
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
}

export interface UseTerminalReturn {
  containerRef: RefObject<HTMLDivElement | null>;
  write: (data: string) => void;
  focus: () => void;
  dispose: () => void;
  clear: () => void;
  readSize: () => { cols: number; rows: number } | null;
}

/** 挂载 xterm、FitAddon 与 ResizeObserver；卸载时释放资源（兼容 StrictMode 双调用） */
export function useTerminal(options: UseTerminalOptions = {}): UseTerminalReturn {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const onDataRef = useRef(options.onData);
  const onResizeRef = useRef(options.onResize);
  onDataRef.current = options.onData;
  onResizeRef.current = options.onResize;

  const dispose = useCallback(() => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    terminalRef.current?.dispose();
    terminalRef.current = null;
    fitAddonRef.current = null;
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      scrollback: 10000,
      rightClickSelectsWord: true,
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace",
      theme: { background: "#1e1e1e", foreground: "#d4d4d4" },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    fitAddon.fit();

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      const sel = term.getSelection();
      if (sel) {
        void navigator.clipboard.writeText(sel);
        term.clearSelection();
      }
    };
    el.addEventListener("contextmenu", onContextMenu);

    const d1 = term.onData((data) => {
      onDataRef.current?.(data);
    });
    const d2 = term.onResize(({ cols, rows }) => {
      onResizeRef.current?.(cols, rows);
    });

    const ro = new ResizeObserver(() => {
      fitAddon.fit();
    });
    ro.observe(el);

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;
    resizeObserverRef.current = ro;

    return () => {
      el.removeEventListener("contextmenu", onContextMenu);
      d1.dispose();
      d2.dispose();
      ro.disconnect();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      resizeObserverRef.current = null;
    };
  }, []);

  const write = useCallback((data: string) => {
    try {
      terminalRef.current?.write(data);
    } catch (err) {
      console.error("[xterm] write error:", err);
    }
  }, []);

  const focus = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  const clear = useCallback(() => {
    terminalRef.current?.clear();
    terminalRef.current?.reset();
  }, []);

  const readSize = useCallback(() => {
    const t = terminalRef.current;
    if (!t) return null;
    return { cols: t.cols, rows: t.rows };
  }, []);

  return { containerRef, write, focus, dispose, clear, readSize };
}
