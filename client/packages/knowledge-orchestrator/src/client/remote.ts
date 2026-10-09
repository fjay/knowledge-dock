import { defaultExec } from "./runner.ts";
import { escapeQuotes } from "../template/escape.ts";

/**
 * 校验 profile 参数，防止命令注入
 */
export function validateProfile(profile: string = "skm"): string {
  const trimmed = String(profile).trim();
  if (!trimmed || !/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new Error(`profile 包含非法字符或为空: ${profile}`);
  }
  return trimmed;
}

/**
 * 侦听远端检查点与变更状态
 */
export async function queryRemoteList(
  profile: string = "skm",
  repoPath: string | null = null,
  execFn: (cmd: string) => Promise<{ stdout: string; stderr: string }> = defaultExec,
  branch?: string | null
): Promise<any> {
  const safeProfile = validateProfile(profile);
  let cmd = `ad run maintenance.list --profile ${safeProfile} --json`;
  if (repoPath) {
    cmd += ` -- path="${escapeQuotes(repoPath)}"`;
    if (branch) {
      cmd += ` branch="${escapeQuotes(branch)}"`;
    }
  }
  const { stdout } = await execFn(cmd);
  const parsed = JSON.parse(stdout);
  if (parsed.ok === false && parsed.error) {
    throw new Error(parsed.error.message || `ActionDock 错误: ${parsed.error.code}`);
  }
  return parsed.data ?? parsed;
}

/**
 * 查询待审池候选列表
 */
export async function queryRemoteInboxList(
  profile: string = "skm",
  execFn: (cmd: string) => Promise<{ stdout: string; stderr: string }> = defaultExec
): Promise<any[]> {
  const safeProfile = validateProfile(profile);
  const cmd = `ad run knowledge.list --profile ${safeProfile} --json -- status="pending"`;
  const { stdout } = await execFn(cmd);
  if (!stdout || !stdout.trim()) {
    return [];
  }
  const parsed = JSON.parse(stdout);
  if (parsed.ok === false && parsed.error) {
    throw new Error(parsed.error.message || `ActionDock 错误: ${parsed.error.code}`);
  }
  const data = parsed.data ?? parsed;
  return Array.isArray(data.items) ? data.items : [];
}

/**
 * 调用远端 maintenance.sync 同步单仓分支
 */
export async function syncRemoteRepo(
  profile: string = "skm",
  repoPath: string,
  execFn: (cmd: string) => Promise<{ stdout: string; stderr: string }> = defaultExec
): Promise<any> {
  const safeProfile = validateProfile(profile);
  const cmd = `ad run maintenance.sync --profile ${safeProfile} --json -- path="${escapeQuotes(repoPath)}"`;
  const { stdout } = await execFn(cmd);
  const parsed = JSON.parse(stdout);
  if (parsed.ok === false && parsed.error) {
    throw new Error(parsed.error.message || `ActionDock 错误: ${parsed.error.code}`);
  }
  return parsed.data ?? parsed;
}

/**
 * 调用远端 maintenance.complete 推进单仓检查点水位
 */
export async function completeRemoteRepo(
  profile: string = "skm",
  repoPath: string,
  commit: string,
  actionTaken: string = "no_change_needed",
  summary: string = "同步系统知识库自身变更",
  execFn: (cmd: string) => Promise<{ stdout: string; stderr: string }> = defaultExec
): Promise<any> {
  const safeProfile = validateProfile(profile);
  const cmd = `ad run maintenance.complete --profile ${safeProfile} --json -- path="${escapeQuotes(repoPath)}" commit="${escapeQuotes(commit)}" actionTaken="${escapeQuotes(actionTaken)}" summary="${escapeQuotes(summary)}"`;
  const { stdout } = await execFn(cmd);
  const parsed = JSON.parse(stdout);
  if (parsed.ok === false && parsed.error) {
    throw new Error(parsed.error.message || `ActionDock 错误: ${parsed.error.code}`);
  }
  return parsed.data ?? parsed;
}

/**
 * 调用远端 maintenance.publish 提交并推送仓库变更
 */
export async function publishRemoteRepo(
  profile: string = "skm",
  repoPath: string,
  options: { branch?: string; push?: boolean; repoType?: string } = {},
  execFn: (cmd: string) => Promise<{ stdout: string; stderr: string }> = defaultExec
): Promise<any> {
  const safeProfile = validateProfile(profile);
  let cmd = `ad run maintenance.publish --profile ${safeProfile} --json -- path="${escapeQuotes(repoPath)}"`;
  if (options.repoType) {
    cmd += ` repoType="${escapeQuotes(options.repoType)}"`;
  }
  if (options.branch) {
    cmd += ` branch="${escapeQuotes(options.branch)}"`;
  }
  if (options.push !== undefined) {
    cmd += ` push=${options.push ? "true" : "false"}`;
  }
  const { stdout } = await execFn(cmd);
  if (!stdout || !stdout.trim()) {
    return { status: "success", pushed: options.push ?? true, committed: false };
  }
  const parsed = JSON.parse(stdout);
  if (parsed.ok === false && parsed.error) {
    throw new Error(parsed.error.message || `ActionDock 错误: ${parsed.error.code}`);
  }
  return parsed.data ?? parsed;
}

