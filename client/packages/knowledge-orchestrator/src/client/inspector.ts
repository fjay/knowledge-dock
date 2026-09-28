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

  // 1. 若指定了任务触发时间戳且远端存在检查点推进时间，判定是否在触发后完成推进
  if (options.dispatchedAt && data.checkpointUpdatedAt) {
    const updatedTime = new Date(data.checkpointUpdatedAt).getTime();
    if (!Number.isNaN(updatedTime) && updatedTime >= options.dispatchedAt) {
      return true;
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
  if (!options.dispatchedAt) {
    if (data.status === "upToDate") {
      return true;
    }

    if (data.hasChanges === false && data.status !== "error") {
      return true;
    }
  }

  return false;
}
