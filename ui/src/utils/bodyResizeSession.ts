export interface BodyResizeSessionOptions {
  onMove: (event: MouseEvent) => void;
  onEnd?: () => void;
}

export function startBodyResizeSession({
  onMove,
  onEnd,
}: BodyResizeSessionOptions): () => void {
  let active = true;
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;

  const cleanup = () => {
    if (!active) return;
    active = false;

    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousUserSelect;

    document.removeEventListener("mousemove", handleMove);
    document.removeEventListener("mousedown", handleNextMouseDown, true);
    document.removeEventListener("mouseup", cleanup);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("blur", cleanup);

    onEnd?.();
  };

  const handleMove = (event: MouseEvent) => {
    if (!active) return;
    if (event.buttons === 0) {
      cleanup();
      return;
    }
    onMove(event);
  };

  const handleNextMouseDown = () => {
    cleanup();
  };

  const handleVisibilityChange = () => {
    if (document.hidden) cleanup();
  };

  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";

  document.addEventListener("mousemove", handleMove);
  document.addEventListener("mousedown", handleNextMouseDown, true);
  document.addEventListener("mouseup", cleanup);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("blur", cleanup);

  return cleanup;
}
