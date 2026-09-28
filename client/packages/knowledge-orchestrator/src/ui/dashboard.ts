import { formatDuration, renderProgressBar } from "./format.ts";
import type { DashboardStats } from "../types.ts";

/**
 * 终端实时看板渲染
 */
export function renderDashboard(stats: DashboardStats): string {
  const progressBar = renderProgressBar(stats.processed, stats.total);
  const lines = [
    `流水线进度: ${progressBar}`,
    `总仓数: ${stats.total} | 已跳过: ${stats.skipped} | 已完成: ${stats.completed} | 失败: ${stats.failed}`,
  ];

  if (stats.activeRepo) {
    lines.push(
      `当前活跃仓: ${stats.activeRepo} | 单仓耗时: ${formatDuration(stats.activeRepoElapsed ?? 0)} | 总耗时: ${formatDuration(stats.totalElapsed)}`
    );
  } else {
    lines.push(`总耗时: ${formatDuration(stats.totalElapsed)}`);
  }

  if (stats.inboxTotal !== undefined && stats.inboxTotal > 0) {
    const inboxBar = renderProgressBar(stats.inboxProcessed ?? 0, stats.inboxTotal);
    lines.push(`待审池进度: ${inboxBar}`);
    lines.push(
      `待审候选总数: ${stats.inboxTotal} | 已归档: ${stats.inboxCompleted ?? 0} | 失败: ${stats.inboxFailed ?? 0}`
    );
    if (stats.activeCandidate) {
      lines.push(
        `当前待审候选: ${stats.activeCandidate} | 单篇耗时: ${formatDuration(stats.activeCandidateElapsed ?? 0)}`
      );
    }
  } else if (stats.inboxSkipped) {
    lines.push(`待审池阶段: 已跳过`);
  }

  return lines.join("\n");
}
