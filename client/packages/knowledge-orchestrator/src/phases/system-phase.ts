import path from "node:path";
import { buildPlaceholders } from "../template/placeholders.ts";
import { dispatchRepo, type RepoDispatchContext } from "./repo-dispatcher.ts";
import type { PipelineOptions, PipelineHooks, RepoResult } from "../types.ts";

export interface SystemPhaseResult {
  results: RepoResult[];
  skippedCount: number;
  completedCount: number;
  failedCount: number;
}

/**
 * 第二阶段：系统知识库全局聚合维护
 */
export async function runSystemKnowledgePhase(
  systemRepos: any[],
  context: {
    options: PipelineOptions;
    hooks: PipelineHooks;
    startTime: number;
    totalRepos: number;
    codePhaseSummary: string;
    updatedCodeReposCount: number;
    getCurrentCounts: () => { skipped: number; completed: number; failed: number };
    onResult: (result: RepoResult) => void;
    writeLog: (msg: string) => void;
  }
): Promise<SystemPhaseResult> {
  const {
    options,
    hooks,
    startTime,
    totalRepos,
    codePhaseSummary,
    updatedCodeReposCount,
    getCurrentCounts,
    onResult,
    writeLog,
  } = context;

  if (systemRepos.length > 0) {
    writeLog(
      `[PHASE2] 开始第二阶段：系统知识库全局聚合维护 (系统仓数: ${systemRepos.length}, 前序更新数: ${updatedCodeReposCount})`
    );
  }

  const results: RepoResult[] = [];
  let skippedCount = 0;
  let completedCount = 0;
  let failedCount = 0;

  for (const repoItem of systemRepos) {
    const repoName = repoItem.repo || (repoItem.path ? path.basename(repoItem.path) : "");

    if (repoItem.status === "error") {
      failedCount++;
      writeLog(`[ERROR] 系统知识库 ${repoName} 扫描失败: ${repoItem.message || "unknown error"}`);
      const res: RepoResult = {
        repo: repoName,
        path: repoItem.path,
        repoType: "system_knowledge",
        status: "failed",
        targetCommit: repoItem.to || repoItem.from || "",
        durationMs: 0,
        message: `远端扫描失败: ${repoItem.message || "unknown error"}`,
      };
      results.push(res);
      onResult(res);
    } else if (
      !repoItem.hasChanges &&
      repoItem.status !== "initial" &&
      repoItem.status !== "changed" &&
      updatedCodeReposCount === 0 &&
      !options.only
    ) {
      skippedCount++;
      writeLog(`[SKIP] 系统知识库 ${repoName} 前序代码仓无更新且基线已对齐，跳过`);
      const res: RepoResult = {
        repo: repoName,
        path: repoItem.path,
        repoType: "system_knowledge",
        status: "skipped",
        targetCommit: repoItem.to || repoItem.from || "",
        durationMs: 0,
        message: "前序代码仓均无变更且系统知识基线已对齐，跳过系统层维护",
      };
      results.push(res);
      onResult(res);
    } else {
      const placeholders = buildPlaceholders(repoItem, { codePhaseSummary });
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

  return {
    results,
    skippedCount,
    completedCount,
    failedCount,
  };
}
