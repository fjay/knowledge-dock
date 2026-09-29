import { formatDuration } from "../ui/format.ts";
import { renderTemplate } from "../template/engine.ts";
import { queryRemoteList } from "../client/remote.ts";
import { defaultExec, triggerDispatch } from "../client/runner.ts";
import { isRepoCompleted } from "../client/inspector.ts";
import type { PipelineOptions, PipelineHooks, RepoResult } from "../types.ts";

export interface RepoDispatchContext {
  options: PipelineOptions;
  hooks: PipelineHooks;
  startTime: number;
  totalRepos: number;
  getProcessedCount: () => number;
  getStats: () => { skipped: number; completed: number; failed: number };
  writeLog: (msg: string) => void;
}

/**
 * 调度单仓维护任务，触发外部智能体并侦听检查点推进
 */
export async function dispatchRepo(
  repoItem: any,
  placeholders: Record<string, any>,
  context: RepoDispatchContext
): Promise<RepoResult> {
  const { options, hooks, startTime, totalRepos, getProcessedCount, getStats, writeLog } = context;
  const {
    execFn = defaultExec,
    dispatchFn = null,
    sleepFn = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    onProgress = null,
    nowFn = Date.now,
  } = hooks;

  const profile = options.profile || "skm";
  const timeoutVal = options.timeout ?? 15;
  const intervalVal = options.interval ?? 10;
  const timeoutMs = timeoutVal * 60 * 1000;
  const intervalMs = intervalVal * 1000;

  const repoName = placeholders.repo;
  const targetCommit = placeholders.to;
  const repoType = (placeholders.repoType || "code") as "code" | "system_knowledge";
  const repoStartTime = nowFn();

  const reportProgress = () => {
    const activeRepoElapsed = nowFn() - repoStartTime;
    const totalElapsed = nowFn() - startTime;
    const stats = getStats();
    if (onProgress) {
      onProgress({
        total: totalRepos,
        processed: getProcessedCount(),
        skipped: stats.skipped,
        completed: stats.completed,
        failed: stats.failed,
        activeRepo: repoName,
        activeRepoElapsed,
        totalElapsed,
      });
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
    writeLog(`[ERROR] 仓库 ${repoName} 派发异常: ${err.message}`);
    return {
      repo: repoName,
      path: repoItem.path,
      repoType,
      status: "failed",
      targetCommit,
      durationMs: nowFn() - repoStartTime,
      message: `派发执行异常: ${err.message}`,
    };
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
      const currentStatus = await queryRemoteList(profile, repoItem.path, execFn, repoItem.branch);
      if (isRepoCompleted(currentStatus, targetCommit, { dispatchedAt: repoStartTime })) {
        isFinished = true;
        break;
      }
    } catch (err: any) {
      writeLog(`[WARN] 仓库 ${repoName} 检查点状态轮询异常: ${err.message || String(err)}`);
    }
  }

  const durationMs = nowFn() - repoStartTime;

  if (isFinished) {
    writeLog(`[SUCCESS] 仓库 ${repoName} 检查点推进成功: ${targetCommit} (耗时: ${formatDuration(durationMs)})`);
    return {
      repo: repoName,
      path: repoItem.path,
      repoType,
      status: "completed",
      targetCommit,
      durationMs,
      message: `检查点已成功推进至 ${targetCommit || "最新水位"}`,
    };
  }

  writeLog(`[TIMEOUT] 仓库 ${repoName} 推进超时 (${timeoutVal} 分钟)`);
  return {
    repo: repoName,
    path: repoItem.path,
    repoType,
    status: "failed",
    targetCommit,
    durationMs,
    message: `等待检查点推进超时 (${timeoutVal} 分钟)，未检测到 ${targetCommit || "推进记录"}`,
  };
}
