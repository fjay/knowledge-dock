import fs from "node:fs";
import path from "node:path";
import { defaultExec, triggerDispatch } from "./client/runner.ts";
import { queryRemoteList } from "./client/remote.ts";
import { isRepoCompleted } from "./client/inspector.ts";
import { renderTemplate } from "./template/engine.ts";
import { buildPlaceholders } from "./template/placeholders.ts";
import { formatDuration } from "./ui/format.ts";
import { generateMarkdownReport } from "./report/markdown.ts";
import { runInboxPhase } from "./phases/inbox-phase.ts";
import type {
  PipelineOptions,
  PipelineHooks,
  DryRunItem,
  DryRunResult,
  RepoResult,
  PipelineSummary,
} from "./types.ts";

// 统一门面导出所有细粒度子模块与类型定义，供 actions/pipeline.ts 与测试套件无缝使用
export * from "./types.ts";
export * from "./ui/format.ts";
export * from "./ui/dashboard.ts";
export * from "./template/escape.ts";
export * from "./template/engine.ts";
export * from "./template/prompts/code-repo.ts";
export * from "./template/prompts/system-knowledge.ts";
export * from "./template/prompts/inbox-candidate.ts";
export * from "./template/prompts/index.ts";
export * from "./template/placeholders.ts";
export * from "./client/runner.ts";
export * from "./client/remote.ts";
export * from "./client/inspector.ts";
export * from "./report/markdown.ts";
export * from "./phases/inbox-phase.ts";

/**
 * 核心调度流水线（支持单仓代码巡检、系统知识库全局聚合与待审池巡检三阶段调度）
 */
export async function runPipeline(
  options: PipelineOptions,
  hooks: PipelineHooks = {}
): Promise<DryRunResult | PipelineSummary> {
  const {
    execFn = defaultExec,
    dispatchFn = null,
    sleepFn = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    onProgress = null,
    logFn = null,
    nowFn = Date.now,
  } = hooks;

  const profile = options.profile || "skm";
  const timeoutVal = options.timeout ?? 15;
  const intervalVal = options.interval ?? 10;
  const startTime = nowFn();

  const writeLog = (msg: string) => {
    if (logFn) {
      logFn(msg);
    }
    if (options.logFile) {
      try {
        const ts = new Date(nowFn()).toISOString().replace("T", " ").replace(/\..+/, "");
        fs.appendFileSync(options.logFile, `[${ts}] ${msg}\n`, "utf8");
      } catch {
        // 容错处理
      }
    }
  };

  writeLog(`开始执行知识维护流水线 (profile=${profile})`);

  // 1. 扫描远端全量或单仓状态
  writeLog("正在扫描远端受管仓库状态与检查点基线...");
  const scanData = await queryRemoteList(profile, null, execFn);

  let allRepos: any[] = [];
  if (Array.isArray(scanData.results)) {
    allRepos = scanData.results;
  } else if (scanData.path) {
    allRepos = [scanData];
  }

  // 2. 按 --only 进行过滤
  if (options.only) {
    const onlySet = new Set(
      options.only
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
    allRepos = allRepos.filter((item) => {
      const repoName = (item.repo || path.basename(item.path || "")).toLowerCase();
      return onlySet.has(repoName);
    });
  }

  // 3. 区分单代码仓 (Phase 1) 与系统知识仓 (Phase 2)
  const codeRepos: any[] = [];
  const systemRepos: any[] = [];

  for (const item of allRepos) {
    const repoName = item.repo || (item.path ? path.basename(item.path) : "");
    const rawType = item.repoType || "";
    const repoType =
      rawType === "system_knowledge" || rawType === "code"
        ? rawType
        : (repoName.toLowerCase().includes("system-knowledge") ||
           repoName.toLowerCase().includes("knowledge-system") ||
           (item.path && (item.path.toLowerCase().includes("system-knowledge") || item.path.toLowerCase().includes("knowledge-system")))
            ? "system_knowledge"
            : "code");

    const enrichedItem = { ...item, repoType };

    if (repoType === "system_knowledge") {
      if (!options.skipSystemKnowledge) {
        systemRepos.push(enrichedItem);
      }
    } else {
      codeRepos.push(enrichedItem);
    }
  }

  // 确保按阶段顺序执行：先单仓代码巡检，后全局系统知识聚合
  const orderedRepos = [...codeRepos, ...systemRepos];

  const results: RepoResult[] = [];
  let skippedCount = 0;
  let completedCount = 0;
  let failedCount = 0;

  // 4. 预演模式处理
  if (options.dryRun) {
    const dryRunOutput: DryRunItem[] = [];
    const pendingCodeRepos: any[] = [];

    for (const item of codeRepos) {
      if (item.status === "error") {
        failedCount++;
      } else if (!item.hasChanges && item.status !== "initial" && item.status !== "changed") {
        skippedCount++;
      } else {
        pendingCodeRepos.push(item);
      }
    }

    for (const item of pendingCodeRepos) {
      const placeholders = buildPlaceholders(item);
      const renderedCmd = options.dispatchCmd
        ? renderTemplate(options.dispatchCmd, placeholders, { escapeQuotes: true })
        : `[未指定 --dispatch-cmd] 目标仓库: ${placeholders.repo}, 待核验提交数: ${placeholders.commitCount}`;
      dryRunOutput.push({
        repo: placeholders.repo,
        path: placeholders.path,
        repoType: placeholders.repoType,
        renderedCommand: renderedCmd,
        placeholders,
      });
    }

    const codePhaseSummaryForDryRun =
      pendingCodeRepos.length > 0
        ? `预演阶段待更新代码仓共 ${pendingCodeRepos.length} 个：` + pendingCodeRepos.map((r) => r.repo || path.basename(r.path || "")).join(", ")
        : "所有代码仓均无变更。";

    for (const item of systemRepos) {
      if (item.status === "error") {
        failedCount++;
      } else if (!item.hasChanges && item.status !== "initial" && item.status !== "changed" && pendingCodeRepos.length === 0 && !options.only) {
        skippedCount++;
      } else {
        const placeholders = buildPlaceholders(item, { codePhaseSummary: codePhaseSummaryForDryRun });
        const renderedCmd = options.dispatchCmd
          ? renderTemplate(options.dispatchCmd, placeholders, { escapeQuotes: true })
          : `[未指定 --dispatch-cmd] 目标系统仓: ${placeholders.repo}`;
        dryRunOutput.push({
          repo: placeholders.repo,
          path: placeholders.path,
          repoType: placeholders.repoType,
          renderedCommand: renderedCmd,
          placeholders,
        });
      }
    }

    return {
      dryRun: true,
      total: orderedRepos.length,
      skipped: skippedCount,
      pending: dryRunOutput.length,
      dryRunOutput,
      inboxTotal: 0,
      inboxCompleted: 0,
      inboxFailed: 0,
      inboxSkipped: options.skipInbox ?? false,
      inboxResults: [],
    };
  }

  // 5. 校验必填参数
  if (!options.dispatchCmd) {
    throw new Error("缺少必需参数：--dispatch-cmd <template>。实际运行时必须提供派发命令模版。");
  }

  // 6. 执行调度辅助处理函数
  const timeoutMs = timeoutVal * 60 * 1000;
  const intervalMs = intervalVal * 1000;

  const processRepoDispatch = async (repoItem: any, placeholders: Record<string, any>) => {
    const repoName = placeholders.repo;
    const targetCommit = placeholders.to;
    const repoType = placeholders.repoType || "code";
    const repoStartTime = nowFn();

    const reportProgress = () => {
      const activeRepoElapsed = nowFn() - repoStartTime;
      const totalElapsed = nowFn() - startTime;
      const stats = {
        total: orderedRepos.length,
        processed: skippedCount + completedCount + failedCount,
        skipped: skippedCount,
        completed: completedCount,
        failed: failedCount,
        activeRepo: repoName,
        activeRepoElapsed,
        totalElapsed,
      };
      if (onProgress) {
        onProgress(stats);
      }
    };

    reportProgress();

    // 渲染派发命令并触发
    const renderedCmd = renderTemplate(options.dispatchCmd!, placeholders, { escapeQuotes: true });
    writeLog(`[DISPATCH] 派发维护任务 -> 仓库: ${repoName} (${repoType}), 目标检查点: ${targetCommit}`);

    try {
      if (dispatchFn) {
        await dispatchFn(renderedCmd, placeholders);
      } else {
        await triggerDispatch(renderedCmd);
      }
    } catch (err: any) {
      failedCount++;
      writeLog(`[ERROR] 仓库 ${repoName} 派发异常: ${err.message}`);
      results.push({
        repo: repoName,
        path: repoItem.path,
        repoType,
        status: "failed",
        targetCommit,
        durationMs: nowFn() - repoStartTime,
        message: `派发执行异常: ${err.message}`,
      });
      return;
    }

    // 进入异步状态侦听循环
    let isFinished = false;
    let isTimedOut = false;

    while (!isFinished && !isTimedOut) {
      reportProgress();

      await sleepFn(intervalMs);

      const elapsed = nowFn() - repoStartTime;
      if (elapsed >= timeoutMs) {
        isTimedOut = true;
        break;
      }

      try {
        const currentStatus = await queryRemoteList(profile, repoItem.path, execFn);
        if (isRepoCompleted(currentStatus, targetCommit, { dispatchedAt: repoStartTime })) {
          isFinished = true;
          break;
        }
      } catch {
        // 网络抖动不中断轮询，持续等待至超时
      }
    }

    const durationMs = nowFn() - repoStartTime;

    if (isFinished) {
      completedCount++;
      writeLog(`[SUCCESS] 仓库 ${repoName} 检查点推进成功: ${targetCommit} (耗时: ${formatDuration(durationMs)})`);
      results.push({
        repo: repoName,
        path: repoItem.path,
        repoType,
        status: "completed",
        targetCommit,
        durationMs,
        message: `检查点已成功推进至 ${targetCommit || "最新水位"}`,
      });
    } else {
      failedCount++;
      writeLog(`[TIMEOUT] 仓库 ${repoName} 推进超时 (${timeoutVal} 分钟)`);
      results.push({
        repo: repoName,
        path: repoItem.path,
        repoType,
        status: "failed",
        targetCommit,
        durationMs,
        message: `等待检查点推进超时 (${timeoutVal} 分钟)，未检测到 ${targetCommit || "推进记录"}`,
      });
    }
  };

  // 7. 第一阶段：单仓代码巡检与知识维护
  writeLog(`[PHASE1] 开始第一阶段：单仓代码巡检 (待处理仓数: ${codeRepos.length})`);
  for (const repoItem of codeRepos) {
    const repoName = repoItem.repo || (repoItem.path ? path.basename(repoItem.path) : "");
    if (repoItem.status === "error") {
      failedCount++;
      writeLog(`[ERROR] 仓库 ${repoName} 扫描失败: ${repoItem.message || "unknown error"}`);
      results.push({
        repo: repoName,
        path: repoItem.path,
        repoType: "code",
        status: "failed",
        targetCommit: repoItem.to || repoItem.from || "",
        durationMs: 0,
        message: `远端扫描失败: ${repoItem.message || "unknown error"}`,
      });
    } else if (!repoItem.hasChanges && repoItem.status !== "initial" && repoItem.status !== "changed") {
      skippedCount++;
      writeLog(`[SKIP] 仓库 ${repoName} (code) 检查点已对齐，跳过`);
      results.push({
        repo: repoName,
        path: repoItem.path,
        repoType: "code",
        status: "skipped",
        targetCommit: repoItem.to || repoItem.from || "",
        durationMs: 0,
        message: "远端检查点已对齐，无待核验代码变更",
      });
    } else {
      const placeholders = buildPlaceholders(repoItem);
      await processRepoDispatch(repoItem, placeholders);
    }
  }

  // 8. 汇总第一阶段巡检成果，为系统知识库提供事实输入
  const updatedCodeRepos = results.filter((r) => r.status === "completed" && r.repoType !== "system_knowledge");
  let codePhaseSummary = "";
  if (updatedCodeRepos.length > 0) {
    codePhaseSummary =
      `前序已完成巡检且发生更新的代码仓（共 ${updatedCodeRepos.length} 个）：\n` +
      updatedCodeRepos.map((r) => `- ${r.repo}：已推进检查点至 ${r.targetCommit || "HEAD"}`).join("\n");
  } else {
    codePhaseSummary = "前序代码仓巡检完毕，所有代码仓均无变更或无需更新文档。";
  }

  // 9. 第二阶段：系统知识库全局聚合维护
  if (systemRepos.length > 0) {
    writeLog(`[PHASE2] 开始第二阶段：系统知识库全局聚合维护 (系统仓数: ${systemRepos.length}, 前序更新数: ${updatedCodeRepos.length})`);
  }
  for (const repoItem of systemRepos) {
    const repoName = repoItem.repo || (repoItem.path ? path.basename(repoItem.path) : "");
    if (repoItem.status === "error") {
      failedCount++;
      writeLog(`[ERROR] 系统知识库 ${repoName} 扫描失败: ${repoItem.message || "unknown error"}`);
      results.push({
        repo: repoName,
        path: repoItem.path,
        repoType: "system_knowledge",
        status: "failed",
        targetCommit: repoItem.to || repoItem.from || "",
        durationMs: 0,
        message: `远端扫描失败: ${repoItem.message || "unknown error"}`,
      });
    } else if (
      !repoItem.hasChanges &&
      repoItem.status !== "initial" &&
      repoItem.status !== "changed" &&
      updatedCodeRepos.length === 0 &&
      !options.only
    ) {
      skippedCount++;
      writeLog(`[SKIP] 系统知识库 ${repoName} 前序代码仓无更新且基线已对齐，跳过`);
      results.push({
        repo: repoName,
        path: repoItem.path,
        repoType: "system_knowledge",
        status: "skipped",
        targetCommit: repoItem.to || repoItem.from || "",
        durationMs: 0,
        message: "前序代码仓均无变更且系统知识基线已对齐，跳过系统层维护",
      });
    } else {
      const placeholders = buildPlaceholders(repoItem, { codePhaseSummary });
      await processRepoDispatch(repoItem, placeholders);
    }
  }

  // 10. 第三阶段：Knowledge Inbox 全局待审池串行巡检与消费
  writeLog(`[PHASE3] 开始第三阶段：Knowledge Inbox 全局待审池巡检与消费`);
  const inboxSummary = await runInboxPhase(options, hooks, {
    startTime,
    codeReposCount: codeRepos.length,
    systemReposCount: systemRepos.length,
    writeLog,
  });

  const totalElapsedMs = nowFn() - startTime;
  writeLog(
    `[SUMMARY] 流水线执行完毕：仓库总计 ${orderedRepos.length} 个（完成 ${completedCount}，跳过 ${skippedCount}，失败 ${failedCount}），待审池候选总计 ${inboxSummary.inboxTotal} 篇（归档 ${inboxSummary.inboxCompleted}，失败 ${inboxSummary.inboxFailed}），总耗时 ${formatDuration(totalElapsedMs)}`
  );

  const summary = {
    profile,
    total: orderedRepos.length,
    completed: completedCount,
    skipped: skippedCount,
    failed: failedCount,
    totalElapsedMs,
    results,
    logFile: options.logFile ?? null,
    success: failedCount === 0 && inboxSummary.inboxFailed === 0,
    inboxTotal: inboxSummary.inboxTotal,
    inboxCompleted: inboxSummary.inboxCompleted,
    inboxFailed: inboxSummary.inboxFailed,
    inboxSkipped: inboxSummary.inboxSkipped,
    inboxResults: inboxSummary.inboxResults,
  };

  const mdReport = generateMarkdownReport(summary);

  let reportSaved = true;
  if (options.reportFile) {
    try {
      fs.writeFileSync(options.reportFile, mdReport, "utf8");
      writeLog(`[REPORT] 结算报告已成功保存至 ${options.reportFile}`);
    } catch (err: any) {
      reportSaved = false;
      writeLog(`[WARN] 结算报告写入失败: ${options.reportFile} (${err.message})`);
    }
  }

  return {
    ...summary,
    markdownReport: mdReport,
    reportSaved,
  };
}
