import type { SessionInfo } from "@shared/types";
import { useI18n } from "../i18n";

/** 根据 Agent 上报的 source 解析来源徽标样式与文案 */
export function getSourceBadgeProps(
  source: string | undefined,
): { className: string; label: string } | null {
  if (!source?.trim()) return null;
  const raw = source.trim();
  const k = raw.toLowerCase();
  const base = "session-tabs__source";
  let mod = `${base}--other`;
  let label = raw;
  if (k === "cursor") {
    mod = `${base}--cursor`;
    label = "Cursor";
  } else if (k === "vscode") {
    mod = `${base}--vscode`;
    label = "Copilot";
  } else if (k === "codex") {
    mod = `${base}--codex`;
    label = "Codex";
  } else if (k === "qwen") {
    mod = `${base}--qwen`;
    label = "Qwen";
  }
  return { className: `${base} ${mod}`, label };
}

/** 来源 IDE 徽标（无 source 时不渲染） */
export function SourceBadge({ source }: { source?: string }) {
  const { t } = useI18n();
  const props = getSourceBadgeProps(source);
  if (!props) return null;
  return (
    <span className={props.className} title={`${t.tooltipSource}: ${source}`}>
      {props.label}
    </span>
  );
}

/** 当前 HTTP 请求状态徽标（无记录时不渲染） */
export function RequestStatusBadge({ status }: { status?: SessionInfo["requestStatus"] }) {
  const { t } = useI18n();
  if (!status) return null;
  const base = "session-tabs__request-status";
  let className: string;
  let label: string;
  if (status === "pending") {
    className = `${base} ${base}--pending`;
    label = t.statusPending;
  } else if (status === "replied") {
    className = `${base} ${base}--replied`;
    label = t.statusReplied;
  } else {
    className = `${base} ${base}--cancelled`;
    label = t.statusCancelled;
  }
  return (
    <span className={className} title={`${t.tooltipStatus}: ${label}`}>
      {label}
    </span>
  );
}
