import { useCallback, useState } from "react";
import { useI18n } from "../i18n";

interface CopyButtonProps {
  text: string;
  className?: string;
  title?: string;
}

export function CopyButton({
  text,
  className = "chat-view__copy-btn",
  title,
}: CopyButtonProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const buttonTitle = title ?? t.copy;

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, [text]);

  return (
    <button
      type="button"
      className={className}
      onClick={handleCopy}
      title={buttonTitle}
      aria-label={buttonTitle}
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path
            d="M3 8.5l3 3 7-7"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <rect x="5" y="1" width="9" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
          <path
            d="M3 5v8.5a1.5 1.5 0 001.5 1.5H11"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}
