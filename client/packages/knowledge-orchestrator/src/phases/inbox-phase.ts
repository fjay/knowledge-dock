import { defaultExec, triggerDispatch } from "../client/runner.ts";
import { queryRemoteInboxList } from "../client/remote.ts";
import { buildInboxPlaceholders } from "../template/placeholders.ts";
import { renderTemplate } from "../template/engine.ts";
import { formatDuration } from "../ui/format.ts";
import type {
  PipelineOptions,
  PipelineHooks,
  InboxCandidateResult,
  InboxPhaseSummary,
} from "../types.ts";

export interface InboxPhaseExtraContext {
  startTime?: number;
  codeReposCount?: number;
  systemReposCount?: number;
  writeLog?: (msg: string) => void;
}

/**
 * 第三阶段：Knowledge Inbox 全局待审池串行巡检与消费
 */
export async function runInboxPhase(
  options: PipelineOptions,
  hooks: PipelineHooks = {},
  extraContext: InboxPhaseExtraContext = {}
): Promise<InboxPhaseSummary> {
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
  const startTime = extraContext.startTime ?? nowFn();
  const writeLog = extraContext.writeLog ?? (() => {});

  // 1. 若配置跳过待审池，直接结算跳过
  if (options.skipInbox) {
    writeLog("[PHASE3] skipInbox 为 true，跳过 Knowledge Inbox 待审池阶段");
    return {
      inboxTotal: 0,
      inboxCompleted: 0,
      inboxFailed: 0,
      inboxSkipped: true,
      inboxResults: [],
    };
  }

  // 2. 执行查询：调用 knowledge.list (status="pending") 获取待审候选列表
  writeLog("正在扫描 Knowledge Inbox 待审池候选列表...");
  let pendingItems: any[] = [];
  try {
    pendingItems = await queryRemoteInboxList(profile, execFn);
  } catch (err: any) {
    writeLog(`[ERROR] 查询待审池候选列表失败: ${err.message}`);
    throw new Error(`查询待审池候选列表失败: ${err.message}`);
  }

  const inboxTotal = pendingItems.length;
  writeLog(`待审池扫描完成，发现待审候选共 ${inboxTotal} 篇`);

  // 3. 若无待审候选，直接跳过并结算
  if (inboxTotal === 0) {
    writeLog("[PHASE3] 待审池为空，无待处理候选文档，直接结算完成");
    return {
      inboxTotal: 0,
      inboxCompleted: 0,
      inboxFailed: 0,
      inboxSkipped: false,
      inboxResults: [],
    };
  }

  const inboxResults: InboxCandidateResult[] = [];
  let inboxCompleted = 0;
  let inboxFailed = 0;

  // 4. 串行循环派发：逐个候选唤醒 Agent 处理并轮询探测移出 pending
  for (let i = 0; i < pendingItems.length; i++) {
    const candidate = pendingItems[i];
    const candidateId = candidate.id || "";
    const candidateTitle = candidate.title || candidate.filename || candidateId;
    const candidateFilename = candidate.filename || "";
    const candidateStartTime = nowFn();

    const reportProgress = () => {
      const activeCandidateElapsed = nowFn() - candidateStartTime;
      const totalElapsed = nowFn() - startTime;
      const stats = {
        total: (extraContext.codeReposCount ?? 0) + (extraContext.systemReposCount ?? 0),
        processed: (extraContext.codeReposCount ?? 0) + (extraContext.systemReposCount ?? 0),
        skipped: 0,
        completed: (extraContext.codeReposCount ?? 0) + (extraContext.systemReposCount ?? 0),
        failed: 0,
        totalElapsed,
        inboxTotal,
        inboxProcessed: inboxCompleted + inboxFailed,
        inboxCompleted,
        inboxFailed,
        inboxSkipped: false,
        activeCandidate: `${candidateId} (${candidateTitle})`,
        activeCandidateElapsed,
      };
      if (onProgress) {
        onProgress(stats);
      }
    };

    reportProgress();

    // 前置检查：若该候选已在前序批次中被初筛或前序终版候选收敛归档（已移出 pending），直接跳过派发并计入完成
    if (i > 0) {
      try {
        const latestPending = await queryRemoteInboxList(profile, execFn);
        const isStillPending = latestPending.some(
          (item: any) => item.id === candidateId || item.filename === candidateFilename
        );
        if (!isStillPending) {
          writeLog(`[SKIP] 待审候选 ${candidateId} 已被初筛或前序终版候选收敛归档，跳过派发`);
          inboxCompleted++;
          inboxResults.push({
            id: candidateId,
            filename: candidateFilename,
            title: candidateTitle,
            durationMs: 0,
            status: "completed",
            error: null,
          });
          reportProgress();
          continue;
        }
      } catch {
        // 容错处理，继续正常派发
      }
    }

    // 组装指导语模版与占位符并渲染派发命令
    const placeholders = buildInboxPlaceholders(candidate);
    const renderedCmd = options.dispatchCmd
      ? renderTemplate(options.dispatchCmd, placeholders, { escapeQuotes: true })
      : "";

    writeLog(`[DISPATCH] 派发待审候选任务 (${i + 1}/${inboxTotal}) -> ID: ${candidateId}, 标题: ${candidateTitle}`);

    try {
      if (dispatchFn) {
        await dispatchFn(renderedCmd, placeholders);
      } else if (renderedCmd) {
        await triggerDispatch(renderedCmd);
      }
    } catch (err: any) {
      inboxFailed++;
      const durationMs = nowFn() - candidateStartTime;
      writeLog(`[ERROR] 待审候选 ${candidateId} 派发异常: ${err.message}`);
      inboxResults.push({
        id: candidateId,
        filename: candidateFilename,
        title: candidateTitle,
        durationMs,
        status: "failed",
        error: `派发执行异常: ${err.message}`,
      });
      continue;
    }

    // 轮询探测：定期调用 knowledge.list(status: "pending")，检查当前 candidate.id 是否已移出待审池
    let isArchived = false;
    let isTimedOut = false;

    while (!isArchived && !isTimedOut) {
      reportProgress();
      await sleepFn(intervalMs);

      const elapsed = nowFn() - candidateStartTime;
      if (elapsed >= timeoutMs) {
        isTimedOut = true;
        break;
      }

      try {
        const currentPending = await queryRemoteInboxList(profile, execFn);
        const stillPending = currentPending.some(
          (item: any) => item.id === candidateId || item.filename === candidateFilename
        );
        if (!stillPending) {
          isArchived = true;
          break;
        }
      } catch {
        // 网络抖动不中断轮询，持续等待至超时
      }
    }

    const durationMs = nowFn() - candidateStartTime;

    if (isArchived) {
      inboxCompleted++;
      writeLog(`[SUCCESS] 待审候选 ${candidateId} 归档成功 (耗时: ${formatDuration(durationMs)})`);
      inboxResults.push({
        id: candidateId,
        filename: candidateFilename,
        title: candidateTitle,
        durationMs,
        status: "completed",
        error: null,
      });
    } else {
      inboxFailed++;
      writeLog(`[TIMEOUT] 待审候选 ${candidateId} 归档超时 (${timeoutVal} 分钟)`);
      inboxResults.push({
        id: candidateId,
        filename: candidateFilename,
        title: candidateTitle,
        durationMs,
        status: "failed",
        error: `等待候选归档超时 (${timeoutVal} 分钟)，未检测到移出待审池`,
      });
    }
  }

  writeLog(`[PHASE3] Knowledge Inbox 待审池巡检消费完毕：总数 ${inboxTotal} 篇，成功归档 ${inboxCompleted} 篇，失败 ${inboxFailed} 篇`);

  return {
    inboxTotal,
    inboxCompleted,
    inboxFailed,
    inboxSkipped: false,
    inboxResults,
  };
}
