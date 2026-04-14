import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useI18n } from "../i18n";

/** 单条斜杠命令定义 */
export interface SlashCommand {
  command: string;
  description: string;
  /** 实际填入输入框的文本 */
  text: string;
}

export interface SlashMenuHandle {
  /** 由 ReplyBox 在 textarea 的 keydown 上转发；若已处理则返回 true */
  handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

interface SlashMenuProps {
  /** 当前输入的 / 及其后缀，用于过滤 */
  filter: string;
  onSelect: (cmd: SlashCommand) => void;
  onClose: () => void;
}

export const SlashMenu = forwardRef<SlashMenuHandle, SlashMenuProps>(
  function SlashMenu({ filter, onSelect, onClose }, ref) {
    const { t, locale } = useI18n();

    const commands = useMemo(
      () => [
        {
          command: t.cmdConfirm,
          description: t.cmdConfirmDesc,
          text: "Confirmed, continue",
        },
        {
          command: t.cmdContinue,
          description: t.cmdContinueDesc,
          text: "请继续",
        },
        {
          command: t.cmdReject,
          description: t.cmdRejectDesc,
          text: "Needs changes:\n",
        },
        {
          command: t.cmdCommit,
          description: t.cmdCommitDesc,
          text: "Confirmed, please commit",
        },
      ],
      [t],
    );

    const filtered = useMemo(() => {
      const q = filter.trim().toLowerCase();
      if (!q) return commands;
      return commands.filter((c) => c.command.toLowerCase().startsWith(q));
    }, [commands, filter]);

    const [activeIndex, setActiveIndex] = useState(0);

    useEffect(() => {
      setActiveIndex(0);
    }, [filter]);

    useEffect(() => {
      setActiveIndex((i) => Math.min(i, Math.max(0, filtered.length - 1)));
    }, [filtered.length]);

    const stateRef = useRef({ filtered, activeIndex });
    stateRef.current = { filtered, activeIndex };

    const itemRefMap = useRef(new Map<string, HTMLButtonElement | null>());

    useEffect(() => {
      const cmd = filtered[activeIndex];
      if (!cmd) return;
      const el = itemRefMap.current.get(cmd.command);
      el?.scrollIntoView({ block: "nearest" });
    }, [activeIndex, filtered]);

    const handleKeyDown = useCallback(
      (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
          return true;
        }

        const { filtered: list, activeIndex: ai } = stateRef.current;

        if (list.length === 0) {
          return false;
        }

        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, list.length - 1));
          return true;
        }

        if (e.key === "ArrowUp") {
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          return true;
        }

        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const cmd = list[ai];
          if (cmd) onSelect(cmd);
          return true;
        }

        return false;
      },
      [onClose, onSelect],
    );

    useImperativeHandle(ref, () => ({ handleKeyDown }), [handleKeyDown]);

    const emptyLabel = locale === "zh" ? "无匹配命令" : "No matching commands";

    return (
      <div className="slash-menu" role="listbox" aria-label="斜杠命令">
        {filtered.length === 0 ? (
          <div className="slash-menu__empty">{emptyLabel}</div>
        ) : (
          filtered.map((cmd, idx) => (
            <button
              key={cmd.command}
              type="button"
              role="option"
              aria-selected={idx === activeIndex}
              ref={(el) => {
                if (el) itemRefMap.current.set(cmd.command, el);
                else itemRefMap.current.delete(cmd.command);
              }}
              className={`slash-menu__item${idx === activeIndex ? " slash-menu__item--active" : ""}`}
              onMouseEnter={() => setActiveIndex(idx)}
              onMouseDown={(e) => {
                // 防止焦点离开 textarea，避免点击无效
                e.preventDefault();
              }}
              onClick={() => onSelect(cmd)}
            >
              <span className="slash-menu__cmd">{cmd.command}</span>
              <span className="slash-menu__desc">{cmd.description}</span>
            </button>
          ))
        )}
      </div>
    );
  },
);
