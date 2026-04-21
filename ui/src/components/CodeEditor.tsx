import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";

export interface CodeEditorRef {
  undo: () => boolean;
  redo: () => boolean;
  focus: () => void;
}

export interface CodeEditorHistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

interface CodeEditorProps {
  value: string;
  onChange: (next: string) => void;
  language?: Extension | null;
  theme?: "light" | "dark";
  onSave?: () => void;
  onHistoryChange?: (state: CodeEditorHistoryState) => void;
  className?: string;
  readOnly?: boolean;
}

// 共享的视觉配置：与原 .file-drawer__editor (font-mono / 13px / 1.6 / padding 12 16 / tab-size 2)
// 完全对齐，避免迁移后视觉跳变；同时显式声明 letter-spacing/font-feature-settings，
// 防止从父级继承的 letter-spacing 让光标位置和选区漂移。
const baseTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    fontFamily: "var(--font-mono)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.6",
    overflow: "auto",
    letterSpacing: "normal",
    fontFeatureSettings: "normal",
    fontVariantLigatures: "none",
  },
  ".cm-content": {
    padding: "12px 16px",
    fontFamily: "var(--font-mono)",
    fontSize: "13px",
    lineHeight: "1.6",
    letterSpacing: "normal",
    fontFeatureSettings: "normal",
    fontVariantLigatures: "none",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "inherit",
    fontFamily: "var(--font-mono)",
    fontSize: "13px",
    lineHeight: "1.6",
    letterSpacing: "normal",
    fontFeatureSettings: "normal",
    fontVariantLigatures: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "3ch",
    paddingInline: "12px 8px",
    fontFamily: "var(--font-mono)",
    fontSize: "13px",
    lineHeight: "1.6",
    letterSpacing: "normal",
    fontFeatureSettings: "normal",
    fontVariantLigatures: "none",
  },
});

// 亮色主题：尽量贴近原 textarea 在 light 下的视觉（白底 + 暗色文字 + 较浅蓝色选区）。
// 暗色直接复用 @codemirror/theme-one-dark 与原 Shiki one-dark-pro 配色一致。
const lightTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "#ffffff",
      color: "#1e1e1e",
    },
    ".cm-content": {
      caretColor: "#1e1e1e",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "#1e1e1e",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: "#b5d6f6",
      },
    ".cm-activeLine": {
      backgroundColor: "transparent",
    },
  },
  { dark: false },
);

export const CodeEditor = forwardRef<CodeEditorRef, CodeEditorProps>(
  function CodeEditor(
    {
      value,
      onChange,
      language,
      theme = "light",
      onSave,
      onHistoryChange,
      className,
      readOnly = false,
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const onSaveRef = useRef(onSave);
    const onHistoryRef = useRef(onHistoryChange);
    const lastReportedHistoryRef = useRef<CodeEditorHistoryState>({
      canUndo: false,
      canRedo: false,
    });
    const langCompartment = useRef(new Compartment());
    const themeCompartment = useRef(new Compartment());
    const readOnlyCompartment = useRef(new Compartment());

    useEffect(() => {
      onChangeRef.current = onChange;
    }, [onChange]);

    useEffect(() => {
      onSaveRef.current = onSave;
    }, [onSave]);

    useEffect(() => {
      onHistoryRef.current = onHistoryChange;
    }, [onHistoryChange]);

    useEffect(() => {
      const host = hostRef.current;
      if (!host || viewRef.current) return;

      const saveKeymap = keymap.of([
        {
          key: "Mod-s",
          run: () => {
            onSaveRef.current?.();
            return true;
          },
          preventDefault: true,
        },
      ]);

      const updateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
        }
        const next: CodeEditorHistoryState = {
          canUndo: undoDepth(update.state) > 0,
          canRedo: redoDepth(update.state) > 0,
        };
        const last = lastReportedHistoryRef.current;
        if (next.canUndo !== last.canUndo || next.canRedo !== last.canRedo) {
          lastReportedHistoryRef.current = next;
          onHistoryRef.current?.(next);
        }
      });

      const initialExtensions: Extension[] = [
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        lineNumbers(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        saveKeymap,
        updateListener,
        EditorState.tabSize.of(2),
        baseTheme,
        langCompartment.current.of(language ?? []),
        themeCompartment.current.of(theme === "dark" ? oneDark : lightTheme),
        readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
      ];

      const state = EditorState.create({
        doc: value,
        extensions: initialExtensions,
      });

      viewRef.current = new EditorView({ state, parent: host });

      return () => {
        viewRef.current?.destroy();
        viewRef.current = null;
        lastReportedHistoryRef.current = { canUndo: false, canRedo: false };
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 受控同步：外部 value 变化（比如外部 reset / 父组件直接 setEditContent）时，
    // 把 doc 替换成新内容；本编辑器自己的输入回调不会走到这里（doc 已经一致）。
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (current !== value) {
        view.dispatch({
          changes: { from: 0, to: current.length, insert: value },
        });
      }
    }, [value]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: langCompartment.current.reconfigure(language ?? []),
      });
    }, [language]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: themeCompartment.current.reconfigure(
          theme === "dark" ? oneDark : lightTheme,
        ),
      });
    }, [theme]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: readOnlyCompartment.current.reconfigure(
          EditorState.readOnly.of(readOnly),
        ),
      });
    }, [readOnly]);

    useImperativeHandle(
      ref,
      () => ({
        undo: () => (viewRef.current ? undo(viewRef.current) : false),
        redo: () => (viewRef.current ? redo(viewRef.current) : false),
        focus: () => viewRef.current?.focus(),
      }),
      [],
    );

    return <div ref={hostRef} className={className} />;
  },
);
