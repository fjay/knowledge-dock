import path from "node:path";
import { buildPlaceholders } from "../template/placeholders.ts";
import { defaultExec } from "../client/runner.ts";
import { syncRemoteRepo, completeRemoteRepo } from "../client/remote.ts";
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

  const profile = options.profile || "skm";
  const { execFn = defaultExec, nowFn = Date.now } = hooks;

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
    const repoStartTime = nowFn();

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
      continue;
    }

    let repoHasChanges = Boolean(
      repoItem.hasChanges ||
      repoItem.status === "initial" ||
      repoItem.status === "changed"
    );

    // 前序代码仓无更新且扫描未检出变动时，若显式开启 syncSystemKnowledge 则主动探测远端最新提交
    if (updatedCodeReposCount === 0 && !repoHasChanges && options.syncSystemKnowledge && !options.only) {
      writeLog(`[SYNC-PROBE] 正在探测系统知识库 ${repoName} 远端是否存在未同步的新提交...`);
      try {
        const probeRes = await syncRemoteRepo(profile, repoItem.path, execFn);
        const probeCommit = probeRes.currentCommit;
        if (probeCommit && probeCommit !== repoItem.from && probeCommit !== repoItem.to) {
          writeLog(`[SYNC-PROBE] 探测到系统知识库 ${repoName} 远端新提交: ${probeCommit}`);
          repoHasChanges = true;
          repoItem.to = probeCommit;
          repoItem.hasChanges = true;
        } else {
          writeLog(`[SYNC-PROBE] 系统知识库 ${repoName} 远端无新提交，基线已对齐`);
        }
      } catch (err: any) {
        writeLog(`[WARN] 探测系统知识库远端引用失败: ${err.message}`);
      }
    }

    // 分支 1：前序无更新且系统仓无更新（未开启 forceSystemKnowledge 或 only）-> 跳过
    if (
      !repoHasChanges &&
      updatedCodeReposCount === 0 &&
      !options.only &&
      !options.forceSystemKnowledge
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
      continue;
    }

    // 分支 2：前序无更新但系统知识库自身有更新，且未要求强制全量 AI 派发 -> 纯同步分支
    if (
      updatedCodeReposCount === 0 &&
      repoHasChanges &&
      !options.forceSystemKnowledge
    ) {
      writeLog(`[SYNC] 系统知识库 ${repoName} 前序代码仓无更新，仅同步自身变动并推进检查点`);
      try {
        const syncRes = await syncRemoteRepo(profile, repoItem.path, execFn);
        if (syncRes.status === "error" || syncRes.status === "conflict" || syncRes.status === "dirty_worktree") {
          throw new Error(syncRes.message || `同步异常状态: ${syncRes.status}`);
        }
        const syncedCommit = syncRes.currentCommit || repoItem.to || repoItem.from || "";
        await completeRemoteRepo(
          profile,
          repoItem.path,
          syncedCommit,
          "synced",
          "前序代码仓无更新，仅同步系统知识库自身变动并对齐检查点",
          execFn
        );
        completedCount++;
        writeLog(`[SUCCESS] 系统知识库 ${repoName} 自身变动同步成功，检查点已推进至 ${syncedCommit}`);
        const res: RepoResult = {
          repo: repoName,
          path: repoItem.path,
          repoType: "system_knowledge",
          status: "completed",
          targetCommit: syncedCommit,
          durationMs: nowFn() - repoStartTime,
          message: `前序代码仓无更新，已完成系统知识库自身变动同步并推进检查点至 ${syncedCommit}`,
        };
        results.push(res);
        onResult(res);
      } catch (err: any) {
        failedCount++;
        writeLog(`[ERROR] 系统知识库 ${repoName} 同步失败: ${err.message}`);
        const res: RepoResult = {
          repo: repoName,
          path: repoItem.path,
          repoType: "system_knowledge",
          status: "failed",
          targetCommit: repoItem.to || repoItem.from || "",
          durationMs: nowFn() - repoStartTime,
          message: `系统知识库同步异常: ${err.message}`,
        };
        results.push(res);
        onResult(res);
      }
      continue;
    }

    // 分支 3：前序代码仓有更新或开启了 forceSystemKnowledge -> 派发外部智能体执行全量跨仓聚合维护
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

  return {
    results,
    skippedCount,
    completedCount,
    failedCount,
  };
}
