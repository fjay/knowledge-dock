import { formatDuration } from "../ui/format.ts";
import type { MarkdownReportData } from "../types.ts";

/**
 * 生成结算 Markdown 报告
 */
export function generateMarkdownReport(reportData: MarkdownReportData = {}): string {
  const {
    profile = "skm",
    total = 0,
    completed = 0,
    skipped = 0,
    failed = 0,
    totalElapsedMs = 0,
    results = [],
    inboxTotal = 0,
    inboxCompleted = 0,
    inboxFailed = 0,
    inboxSkipped = false,
    inboxResults = [],
  } = reportData;

  const totalDurationStr = formatDuration(totalElapsedMs);

  let md = `# 知识维护流水线执行报告\n\n`;
  md += `- 执行环境配置：${profile}\n`;
  md += `- 扫描总仓库数：${total}\n`;
  md += `- 维护成功数：${completed}\n`;
  md += `- 跳过无需更新数：${skipped}\n`;
  md += `- 失败或超时数：${failed}\n`;
  md += `- 待审候选总数：${inboxTotal}\n`;
  md += `- 待审成功归档数：${inboxCompleted}\n`;
  md += `- 待审处理失败数：${inboxFailed}\n`;
  if (inboxSkipped) {
    md += `- 待审池状态：已跳过\n`;
  }
  md += `- 流水线总耗时：${totalDurationStr}\n\n`;
  md += `## 仓库执行明细\n\n`;

  if (results.length === 0) {
    md += `- 无待处理仓库明细记录\n`;
  } else {
    for (const r of results) {
      const statusText =
        r.status === "completed"
          ? "成功闭环"
          : r.status === "skipped"
          ? "无需更新"
          : "执行失败";
      const durationStr = formatDuration(r.durationMs || 0);
      const repoTypeLabel = r.repoType === "system_knowledge" ? "系统知识库" : "业务代码仓";
      md += `- 仓库标识：${r.repo}（${repoTypeLabel}）\n`;
      md += `  - 远端路径：${r.path}\n`;
      md += `  - 执行状态：${statusText}\n`;
      if (r.targetCommit) {
        md += `  - 目标检查点：${r.targetCommit}\n`;
      }
      md += `  - 耗时：${durationStr}\n`;
      if (r.message) {
        md += `  - 说明：${r.message}\n`;
      }
    }
  }

  md += `\n## 待审池处理明细\n\n`;
  if (inboxSkipped) {
    md += `- 待审池阶段已按配置跳过巡检\n`;
  } else if (inboxResults.length === 0) {
    md += `- 待审池无待处理候选文档\n`;
  } else {
    md += `| 候选标识 | 候选标题 | 文件名 | 状态 | 耗时 | 说明 |\n`;
    md += `|---|---|---|---|---|---|\n`;
    for (const item of inboxResults) {
      const statusText = item.status === "completed" ? "成功归档" : "处理失败";
      const durationStr = formatDuration(item.durationMs || 0);
      const note = item.status === "completed" ? "已完成归档闭环" : (item.error || "处理失败");
      const safeTitle = (item.title || "").replace(/\|/g, "\\|");
      const safeFilename = (item.filename || "").replace(/\|/g, "\\|");
      const safeNote = (note || "").replace(/\|/g, "\\|");
      md += `| ${item.id} | ${safeTitle} | ${safeFilename} | ${statusText} | ${durationStr} | ${safeNote} |\n`;
    }
  }

  return md;
}
