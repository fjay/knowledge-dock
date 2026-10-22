import fs from "node:fs";
import path from "node:path";
import { defaultExec } from "./client/runner.ts";
import { queryRemoteList } from "./client/remote.ts";
import { renderTemplate } from "./template/engine.ts";
import { buildPlaceholders } from "./template/placeholders.ts";
import { formatDuration, formatLogTimestamp } from "./ui/format.ts";
import { generateMarkdownReport } from "./report/markdown.ts";
import { runCodePhase } from "./phases/code-phase.ts";
import { runSystemKnowledgePhase } from "./phases/system-phase.ts";
import { runInboxPhase } from "./phases/inbox-phase.ts";
import type {
  PipelineOptions,
  PipelineHooks,
  DryRunItem,
  DryRunResult,
  RepoResult,
  PipelineSummary,
} from "./types.ts";

function resolvePipelineRepoType(item: any): "code" | "system_knowledge" | "inbox" {
  if (["code", "system_knowledge", "inbox"].includes(item.repoType)) return item.repoType;
  const name = `${item.repo || ""} ${item.path || ""}`.toLowerCase();
  return name.includes("system-knowledge") || name.includes("knowledge-system") ? "system_knowledge" : "code";
}

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
export * from "./phases/repo-dispatcher.ts";
export * from "./phases/code-phase.ts";
export * from "./phases/system-phase.ts";
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
    logFn = null,
    nowFn = Date.now,
  } = hooks;

  const mode = options.mode ?? "incremental";
  if (mode !== "incremental" && mode !== "backfill") {
    throw new Error(`未知维护模式：${mode}`);
  }
  const isBackfill = mode === "backfill";
  const skipInbox = isBackfill || (options.skipInbox ?? false);
  const profile = options.profile || "skm";
  const startTime = nowFn();

  const writeLog = (msg: string) => {
    if (logFn) {
      logFn(msg);
    }
    if (options.logFile) {
      try {
        const ts = formatLogTimestamp(nowFn());
        fs.appendFileSync(options.logFile, `[${ts}] ${msg}\n`, "utf8");
      } catch {
        // 容错处理
      }
    }
  };

  writeLog(`开始执行知识维护流水线 (profile=${profile}, mode=${mode})`);

  // 1. 扫描远端全量或单仓状态
  writeLog("正在扫描远端受管仓库状态与检查点基线...");
  const scanData = await queryRemoteList(profile, null, execFn, null, { fetch: true });

  let allRepos: any[] = [];
  if (Array.isArray(scanData.results)) {
    allRepos = scanData.results;
  } else if (scanData.path) {
    allRepos = [scanData];
  }

  const scannedRepos = allRepos;

  // 2. 按 only 限定单仓范围；补齐后的系统聚合保留完整扫描中的系统仓。
  const onlySet = options.only != null
    ? new Set(options.only.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))
    : null;
  if (isBackfill && onlySet?.size === 0) {
    throw new Error("补齐模式的 only 不能为空；省略 only 才表示全部受管仓库");
  }
  if (options.only) {
    allRepos = allRepos.filter((item) => {
      const repoName = (item.repo || path.basename(item.path || "")).toLowerCase();
      return onlySet!.has(repoName);
    });
  }

  // 3. 区分单代码仓 (Phase 1) 与系统知识仓 (Phase 2)
  const codeRepos: any[] = [];
  const systemRepos: any[] = [];

  for (const item of allRepos) {
    if (item.repoType === "inbox") {
      writeLog(`检测到待审池仓库 (${item.repo || item.path})，不纳入代码仓或系统知识仓，由第三阶段待审池统一处理`);
      continue;
    }

    const repoType = resolvePipelineRepoType(item);

    const enrichedItem = { ...item, repoType };

    if (repoType === "system_knowledge") {
      if (!options.skipSystemKnowledge) {
        systemRepos.push(enrichedItem);
      }
    } else {
      codeRepos.push(enrichedItem);
    }
  }

  const systemScope = isBackfill && codeRepos.length > 0 ? "related" : "full";
  if (isBackfill && codeRepos.length > 0 && !options.skipSystemKnowledge) {
    for (const item of scannedRepos) {
      if (resolvePipelineRepoType(item) === "system_knowledge" && !systemRepos.some((repo) => repo.path === item.path)) {
        systemRepos.push({ ...item, repoType: "system_knowledge" });
      }
    }
    if (systemRepos.length === 0) {
      throw new Error("补齐后需要系统知识库聚合，但未发现受管系统知识仓；仅补单仓请显式设置 skipSystemKnowledge=true");
    }
  }

  // 确保按阶段顺序执行：先单仓代码巡检，后系统知识聚合。
  const orderedRepos = [...codeRepos, ...systemRepos];
  if (isBackfill) {
    const selectedNames = new Set(orderedRepos.map((item) =>
      (item.repo || path.basename(item.path || "")).toLowerCase()
    ));
    const unmatched = [...(onlySet ?? [])].filter((name) => !selectedNames.has(name));
    if (unmatched.length > 0) {
      throw new Error(`补齐范围包含未匹配或不可处理的仓库：${unmatched.join(", ")}`);
    }
    if (orderedRepos.length === 0) {
      throw new Error("补齐范围内没有可处理的代码仓或系统知识仓");
    }
    writeLog(`[BACKFILL] 执行仓库范围：${[...selectedNames].join(", ")}；系统阶段：${options.skipSystemKnowledge ? "显式跳过" : systemScope === "related" ? "本次单仓知识定向聚合" : "系统层全景补齐"}；跳过 Inbox`);
  }

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
      } else if (!isBackfill && !item.hasChanges && item.status !== "initial" && item.status !== "changed") {
        skippedCount++;
      } else {
        pendingCodeRepos.push(item);
      }
    }

    for (const item of pendingCodeRepos) {
      const placeholders = buildPlaceholders(item, { mode });
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
        ? `预演阶段待维护代码仓共 ${pendingCodeRepos.length} 个：\n` + pendingCodeRepos.map((r) =>
          `- ${r.repo || path.basename(r.path || "")}；路径：${r.path}；知识目录：${r.path}/docs/knowledge/`
        ).join("\n") + "\n本次文档清单与主题摘要将在单仓实际完成后注入，预演不复用历史交接记录。"
        : "本次没有待派发的代码仓。";

    for (const item of systemRepos) {
      if (item.status === "error") {
        failedCount++;
      } else if ((isBackfill && systemScope === "related" && pendingCodeRepos.length === 0) ||
        (!isBackfill && !item.hasChanges && item.status !== "initial" && item.status !== "changed" && pendingCodeRepos.length === 0 && !options.only && !options.forceSystemKnowledge)) {
        skippedCount++;
      } else {
        const placeholders = buildPlaceholders(item, { mode, systemScope, codePhaseSummary: codePhaseSummaryForDryRun });
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
      mode,
      dryRun: true,
      total: orderedRepos.length,
      skipped: skippedCount,
      pending: dryRunOutput.length,
      failed: failedCount,
      dryRunOutput,
      inboxTotal: 0,
      inboxCompleted: 0,
      inboxFailed: 0,
      inboxSkipped: skipInbox,
      inboxResults: [],
    };
  }

  // 5. 校验必填参数
  if (!options.dispatchCmd) {
    throw new Error("缺少必需参数：--dispatch-cmd <template>。实际运行时必须提供派发命令模版。");
  }

  const results: RepoResult[] = [];

  const getCurrentCounts = () => ({
    skipped: skippedCount,
    completed: completedCount,
    failed: failedCount,
  });

  const onResult = (res: RepoResult) => {
    if (res.status === "completed") {
      completedCount++;
    } else if (res.status === "skipped") {
      skippedCount++;
    } else if (res.status === "failed") {
      failedCount++;
    }
  };

  // 6. 第一阶段：单仓代码巡检与知识维护
  const codePhaseResult = await runCodePhase(codeRepos, {
    options,
    hooks,
    startTime,
    totalRepos: orderedRepos.length,
    getCurrentCounts,
    onResult,
    writeLog,
  });
  results.push(...codePhaseResult.results);

  // 7. 第二阶段：系统知识库全局聚合维护
  const systemPhaseResult = await runSystemKnowledgePhase(systemRepos, {
    options,
    hooks,
    startTime,
    totalRepos: orderedRepos.length,
    systemScope,
    codePhaseSummary: codePhaseResult.codePhaseSummary,
    updatedCodeReposCount: codePhaseResult.updatedCodeReposCount,
    getCurrentCounts,
    onResult,
    writeLog,
  });
  results.push(...systemPhaseResult.results);

  // 8. 第三阶段：Knowledge Inbox 全局待审池串行巡检与消费
  writeLog(`[PHASE3] 开始第三阶段：Knowledge Inbox 全局待审池巡检与消费`);
  const inboxRepoItem = allRepos.find((item) => item.repoType === "inbox");
  const inboxPath = inboxRepoItem?.path || "/srv/knowledge-inbox";

  const inboxSummary = await runInboxPhase({ ...options, skipInbox }, hooks, {
    startTime,
    codeReposCount: codeRepos.length,
    systemReposCount: systemRepos.length,
    inboxPath,
    writeLog,
  });

  const totalElapsedMs = nowFn() - startTime;
  writeLog(
    `[SUMMARY] 流水线执行完毕：仓库总计 ${orderedRepos.length} 个（完成 ${completedCount}，跳过 ${skippedCount}，失败 ${failedCount}），待审池候选总计 ${inboxSummary.inboxTotal} 篇（归档 ${inboxSummary.inboxCompleted}，失败 ${inboxSummary.inboxFailed}），总耗时 ${formatDuration(totalElapsedMs)}`
  );

  const summary = {
    mode,
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
    inboxPushed: inboxSummary.inboxPushed,
    inboxPushMessage: inboxSummary.inboxPushMessage ?? null,
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
