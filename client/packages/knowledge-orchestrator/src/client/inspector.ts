/**
 * 判定仓库是否完成检查点闭环
 */
export function isRepoCompleted(
  statusResult: any,
  targetCommit?: string | null,
  options: { dispatchedAt?: number } = {}
): boolean {
  if (!statusResult) return false;
  const data = statusResult.data || statusResult;
  if (!data || typeof data !== "object") return false;

  if (data.status === "error") {
    return false;
  }

  const dispatchedAt =
    typeof options.dispatchedAt === "number"
      ? options.dispatchedAt
      : options.dispatchedAt
        ? new Date(options.dispatchedAt).getTime()
        : undefined;

  // 1. 若指定了任务触发时间戳且远端存在检查点推进时间，基于推进时间判定
  if (dispatchedAt !== undefined && !Number.isNaN(dispatchedAt) && data.checkpointUpdatedAt) {
    const updatedTime = new Date(data.checkpointUpdatedAt).getTime();
    if (!Number.isNaN(updatedTime)) {
      if (updatedTime >= dispatchedAt) {
        return true;
      }
      // 检查点更新时间早于任务派发时间，说明尚未完成本次推进，防止因 targetCommit 恰好等于历史 from 而被提前放行
      return false;
    }
  }

  // 2. 检查 targetCommit 是否与当前水位对齐
  if (targetCommit) {
    const currentFrom = data.from ? String(data.from).trim() : null;
    const target = String(targetCommit).trim();
    if (currentFrom && (currentFrom === target || currentFrom.startsWith(target) || target.startsWith(currentFrom))) {
      return true;
    }
  }

  // 3. 针对未指定 dispatchedAt 的常规对齐判断
  if (dispatchedAt === undefined || Number.isNaN(dispatchedAt)) {
    if (data.status === "upToDate") {
      return true;
    }

    if (data.hasChanges === false) {
      return true;
    }
  }

  return false;
}
