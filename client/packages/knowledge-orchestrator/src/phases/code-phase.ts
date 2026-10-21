import path from "node:path";
import { buildPlaceholders } from "../template/placeholders.ts";
import { dispatchRepo, type RepoDispatchContext } from "./repo-dispatcher.ts";
import { syncRemoteRepo, abortMergeRemoteRepo } from "../client/remote.ts";
import { defaultExec } from "../client/runner.ts";
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

  const isBackfill = options.mode === "backfill";
  const profile = options.profile || "skm";
  const { execFn = defaultExec } = hooks;

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
    } else if (!isBackfill && !repoItem.hasChanges && repoItem.status !== "initial" && repoItem.status !== "changed") {
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
      writeLog(`[SYNC] 开始同步仓库 ${repoName} (release -> docs)...`);
      let syncRes: any;
      try {
        syncRes = await syncRemoteRepo(profile, repoItem.path, execFn, { preserveConflict: true });
      } catch (err: any) {
        failedCount++;
        writeLog(`[ERROR] 仓库 ${repoName} 分支同步异常: ${err.message}`);
        const res: RepoResult = {
          repo: repoName,
          path: repoItem.path,
          repoType: "code",
          status: "failed",
          targetCommit: repoItem.to || repoItem.from || "",
          durationMs: 0,
          message: `分支同步失败: ${err.message}`,
        };
        results.push(res);
        onResult(res);
        continue;
      }

      if (syncRes.status === "dirty_worktree") {
        failedCount++;
        writeLog(`[ERROR] 仓库 ${repoName} 工作区存在未提交修改，跳过并记录失败`);
        const res: RepoResult = {
          repo: repoName,
          path: repoItem.path,
          repoType: "code",
          status: "failed",
          targetCommit: repoItem.to || repoItem.from || "",
          durationMs: 0,
          message: "工作区存在未提交修改，同步中止",
        };
        results.push(res);
        onResult(res);
        continue;
      }

      if (syncRes.status === "error") {
        failedCount++;
        writeLog(`[ERROR] 仓库 ${repoName} 同步失败: ${syncRes.message || "unknown error"}`);
        const res: RepoResult = {
          repo: repoName,
          path: repoItem.path,
          repoType: "code",
          status: "failed",
          targetCommit: repoItem.to || repoItem.from || "",
          durationMs: 0,
          message: `远端同步失败: ${syncRes.message || "unknown error"}`,
        };
        results.push(res);
        onResult(res);
        continue;
      }

      const isConflict = syncRes.status === "conflict";
      if (isConflict) {
        writeLog(
          `[CONFLICT] 仓库 ${repoName} 存在合并冲突，保留现场并派发智能体自主消解 (冲突文件数: ${syncRes.conflictFiles?.length || 0})`
        );
      }

      const placeholders = buildPlaceholders(
        {
          ...repoItem,
          isConflict,
          conflictFiles: syncRes.conflictFiles || [],
          knowledgeBranch: syncRes.knowledgeBranch || "docs",
        },
        {
          mode: options.mode ?? "incremental",
          isConflict,
          conflictFiles: syncRes.conflictFiles || [],
          knowledgeBranch: syncRes.knowledgeBranch || "docs",
        }
      );

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
        if (isConflict) {
          writeLog(`[CLEANUP] 仓库 ${repoName} 冲突消解未完成，执行自动回滚清理以恢复干净工作区...`);
          await abortMergeRemoteRepo(profile, repoItem.path, execFn);
        }
      }
      results.push(res);
      onResult(res);
    }
  }

  const updatedCodeRepos = results.filter((r) => r.status === "completed" && r.actionTaken !== "skipped");
  let codePhaseSummary = "";
  if (updatedCodeRepos.length > 0) {
    codePhaseSummary =
      `前序已完成知识维护的代码仓（共 ${updatedCodeRepos.length} 个，仅包含本次成功任务）：\n` +
      updatedCodeRepos.map((r) => [
        `- 仓库：${r.repo}；路径：${r.path}；检查点：${r.targetCommit || "HEAD"}`,
        `  - 知识目录：${r.path}/docs/knowledge/`,
        `  - 本次处置：${r.actionTaken || "未回传"}`,
        `  - 本次主题摘要：${r.checkpointSummary || "未回传，须读取该仓知识索引与文档核验"}`,
        `  - 本次文档变更：`,
        ...(r.knowledgeChanges === undefined
          ? [`    - 未回传清单，不能据此认定无改动，也不能使用历史清单冒充本次结果。请仅围绕该仓知识目录与相关主题定向核验。`]
          : r.knowledgeChanges.length === 0
            ? [`    - 本次未产生文档改动（已核验）。`]
            : r.knowledgeChanges.map((change) => `    - ${change.path}：${change.summary}`)),
      ].join("\n")).join("\n");
  } else {
    codePhaseSummary = "本次没有成功完成知识维护的代码仓；未派发或失败仓不能作为已同步依据。";
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
