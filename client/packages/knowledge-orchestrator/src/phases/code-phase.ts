import path from "node:path";
import { buildPlaceholders } from "../template/placeholders.ts";
import { dispatchRepo, type RepoDispatchContext } from "./repo-dispatcher.ts";
import type { PipelineOptions, PipelineHooks, RepoResult } from "../types.ts";

export interface CodePhaseResult {
  results: RepoResult[];
  skippedCount: number;
  completedCount: number;
  failedCount: number;
  codePhaseSummary: string;
  updatedCodeReposCount: number;
}

/**
 * 第一阶段：单仓代码巡检与知识维护
 */
export async function runCodePhase(
  codeRepos: any[],
  context: {
    options: PipelineOptions;
    hooks: PipelineHooks;
    startTime: number;
    totalRepos: number;
    getCurrentCounts: () => { skipped: number; completed: number; failed: number };
    onResult: (result: RepoResult) => void;
    writeLog: (msg: string) => void;
  }
): Promise<CodePhaseResult> {
  const { options, hooks, startTime, totalRepos, getCurrentCounts, onResult, writeLog } = context;
  writeLog(`[PHASE1] 开始第一阶段：单仓代码巡检 (待处理仓数: ${codeRepos.length})`);

  const results: RepoResult[] = [];
  let skippedCount = 0;
  let completedCount = 0;
  let failedCount = 0;

  for (const repoItem of codeRepos) {
    const repoName = repoItem.repo || (repoItem.path ? path.basename(repoItem.path) : "");

    if (repoItem.status === "error") {
      failedCount++;
      writeLog(`[ERROR] 仓库 ${repoName} 扫描失败: ${repoItem.message || "unknown error"}`);
      const res: RepoResult = {
        repo: repoName,
        path: repoItem.path,
        repoType: "code",
        status: "failed",
        targetCommit: repoItem.to || repoItem.from || "",
        durationMs: 0,
        message: `远端扫描失败: ${repoItem.message || "unknown error"}`,
      };
      results.push(res);
      onResult(res);
    } else if (!repoItem.hasChanges && repoItem.status !== "initial" && repoItem.status !== "changed") {
      skippedCount++;
      writeLog(`[SKIP] 仓库 ${repoName} (code) 检查点已对齐，跳过`);
      const res: RepoResult = {
        repo: repoName,
        path: repoItem.path,
        repoType: "code",
        status: "skipped",
        targetCommit: repoItem.to || repoItem.from || "",
        durationMs: 0,
        message: "远端检查点已对齐，无待核验代码变更",
      };
      results.push(res);
      onResult(res);
    } else {
      const placeholders = buildPlaceholders(repoItem);
      const dispatchContext: RepoDispatchContext = {
        options,
        hooks,
        startTime,
        totalRepos,
        getProcessedCount: () => {
          const c = getCurrentCounts();
          return c.skipped + c.completed + c.failed;
        },
        getStats: getCurrentCounts,
        writeLog,
      };

      const res = await dispatchRepo(repoItem, placeholders, dispatchContext);
      if (res.status === "completed") {
        completedCount++;
      } else {
        failedCount++;
      }
      results.push(res);
      onResult(res);
    }
  }

  const updatedCodeRepos = results.filter((r) => r.status === "completed");
  let codePhaseSummary = "";
  if (updatedCodeRepos.length > 0) {
    codePhaseSummary =
      `前序已完成巡检且发生更新的代码仓（共 ${updatedCodeRepos.length} 个）：\n` +
      updatedCodeRepos.map((r) => `- ${r.repo}：已推进检查点至 ${r.targetCommit || "HEAD"}`).join("\n");
  } else {
    codePhaseSummary = "前序代码仓巡检完毕，所有代码仓均无变更或无需更新文档。";
  }

  return {
    results,
    skippedCount,
    completedCount,
    failedCount,
    codePhaseSummary,
    updatedCodeReposCount: updatedCodeRepos.length,
  };
}
