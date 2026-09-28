/**
 * 格式化耗时（毫秒转为分秒格式）
 */
export function formatDuration(ms: number = 0): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * 进度条字符串渲染
 */
export function renderProgressBar(current: number = 0, total: number = 0, width: number = 20): string {
  if (total <= 0) return `[${"=".repeat(width)}] 100%`;
  const ratio = Math.min(1, Math.max(0, current / total));
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const bar = "=".repeat(Math.max(0, filled - 1)) + (filled > 0 ? ">" : "") + " ".repeat(empty);
  const percent = Math.round(ratio * 100);
  return `[${bar}] ${percent}% (${current}/${total})`;
}
