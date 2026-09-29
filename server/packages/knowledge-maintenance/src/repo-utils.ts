import fs from "node:fs";
import path from "node:path";
import type { GitClient } from "./git.ts";
import { MaintenanceError } from "./errors.ts";

export interface DiffStatResult {
  summaryText: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: Array<{
    file: string;
    changes: string;
  }>;
}

export interface ParsedCommit {
  hash: string;
  shortHash: string;
  message: string;
  author?: string;
  date?: string;
}

export interface ResolveRepoPathOptions {
  allowNonExistent?: boolean | undefined;
}

/**
 * Validates and resolves local repository directory path.
 */
export function resolveRepoPath(
  rawPath: string,
  options?: ResolveRepoPathOptions
): string {
  if (!rawPath || typeof rawPath !== "string") {
    throw new MaintenanceError("Path parameter is required", "INVALID_PATH", 400);
  }
  const resolved = path.resolve(rawPath);
  const rawWsRoot =
    (process.env.WORKSPACE_ROOT && process.env.WORKSPACE_ROOT.trim()) ||
    (fs.existsSync("/srv/workspace") ? "/srv/workspace" : undefined);
  const rawInboxRoot =
    (process.env.KNOWLEDGE_INBOX_ROOT && process.env.KNOWLEDGE_INBOX_ROOT.trim()) ||
    (fs.existsSync("/srv/knowledge-inbox") ? "/srv/knowledge-inbox" : undefined);

  const allowedRoots: Array<{ root: string; realRoot: string }> = [];
  if (rawWsRoot) {
    const wsRoot = path.resolve(rawWsRoot);
    const realWsRoot = fs.existsSync(wsRoot) ? fs.realpathSync(wsRoot) : wsRoot;
    allowedRoots.push({ root: wsRoot, realRoot: realWsRoot });
  }
  if (rawInboxRoot) {
    const inboxRoot = path.resolve(rawInboxRoot);
    const realInboxRoot = fs.existsSync(inboxRoot) ? fs.realpathSync(inboxRoot) : inboxRoot;
    allowedRoots.push({ root: inboxRoot, realRoot: realInboxRoot });
  }

  if (allowedRoots.length > 0) {
    const isInsideAllowed = (p: string) =>
      allowedRoots.some(
        ({ root, realRoot }) =>
          p === root ||
          p.startsWith(root + path.sep) ||
          p === realRoot ||
          p.startsWith(realRoot + path.sep)
      );

    if (!isInsideAllowed(resolved)) {
      throw new MaintenanceError(`Path is outside workspace root: ${resolved}`, "PATH_FORBIDDEN", 403);
    }

    if (fs.existsSync(resolved)) {
      const realResolved = fs.realpathSync(resolved);
      if (!isInsideAllowed(realResolved)) {
        throw new MaintenanceError(
          `Path or symlink target is outside workspace root: ${resolved}`,
          "PATH_FORBIDDEN",
          403
        );
      }
    } else if (options?.allowNonExistent) {
      // 若候选路径本身是个悬空软链接，检测软链接目标的真实物理路径
      let isSymlink = false;
      try {
        const lstat = fs.lstatSync(resolved);
        isSymlink = lstat.isSymbolicLink();
      } catch {
        // not a symlink / does not exist
      }
      if (isSymlink) {
        try {
          const linkTarget = fs.readlinkSync(resolved);
          const resolvedTarget = path.resolve(path.dirname(resolved), linkTarget);
          const realTarget = fs.existsSync(resolvedTarget)
            ? fs.realpathSync(resolvedTarget)
            : resolvedTarget;
          if (!isInsideAllowed(realTarget)) {
            throw new MaintenanceError(
              `Path or symlink target is outside workspace root: ${resolved}`,
              "PATH_FORBIDDEN",
              403
            );
          }
        } catch (err: any) {
          if (err instanceof MaintenanceError) throw err;
        }
      }

      // 查找其最近存在的祖先目录，获取其 realpath，同样校验该祖先目录的真实物理路径必须在 allowedRoots 之下
      let checkDir = path.dirname(resolved);
      while (!fs.existsSync(checkDir)) {
        const nextDir = path.dirname(checkDir);
        if (nextDir === checkDir) break;
        checkDir = nextDir;
      }
      if (fs.existsSync(checkDir)) {
        const realAncestor = fs.realpathSync(checkDir);
        if (!isInsideAllowed(realAncestor)) {
          throw new MaintenanceError(
            `Path or symlink target is outside workspace root: ${resolved}`,
            "PATH_FORBIDDEN",
            403
          );
        }
      }
    }
  }
  if (!fs.existsSync(resolved)) {
    if (options?.allowNonExistent) {
      return resolved;
    }
    throw new MaintenanceError(`Path does not exist: ${rawPath}`, "PATH_NOT_FOUND", 404);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new MaintenanceError(`Path is not a directory: ${rawPath}`, "NOT_A_DIRECTORY", 400);
  }
  return resolved;
}

/**
 * Derives repository name from remote origin URL or directory basename.
 */
export async function getRepoIdentifier(git: GitClient, resolvedPath: string): Promise<string> {
  try {
    const remoteUrl = await git.getRemoteUrl();
    if (remoteUrl) {
      // Examples:
      // https://github.com/org/order-service.git -> order-service
      // git@github.com:org/order-service.git -> order-service
      const match = remoteUrl.match(/\/([^/]+?)(?:\.git)?$/);
      if (match && match[1]) {
        return match[1];
      }
    }
  } catch {
    // Ignore and fallback to directory name
  }
  return path.basename(resolvedPath);
}

/**
 * Auto-detects repository type (code vs system_knowledge) based on branches.
 */
export async function detectRepoType(
  git: GitClient,
  knowledgeBranchHint?: string
): Promise<"code" | "system_knowledge" | "inbox"> {
  if (knowledgeBranchHint) {
    return "code";
  }
  const branches = await git.listBranchNames();
  const hasRelease = branches.some((b) => b === "release" || b === "origin/release");
  const hasDocs = branches.some((b) => b === "docs" || b === "origin/docs");

  if (hasRelease || hasDocs) {
    return "code";
  }
  return "system_knowledge";
}

/**
 * Parses git log custom format output into structured commit list.
 * Format expected: %H%x09%h%x09%an <%ae>%x09%aI%x09%s
 */
export function parseGitLog(logOutput: string): ParsedCommit[] {
  if (!logOutput || !logOutput.trim()) {
    return [];
  }
  const lines = logOutput.trim().split("\n");
  const commits: ParsedCommit[] = [];

  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length >= 3) {
      const hash = parts[0] ? parts[0].trim() : "";
      const shortHash = parts[1] ? parts[1].trim() : "";
      const author = parts[2] ? parts[2].trim() : undefined;
      const date = parts[3] ? parts[3].trim() : undefined;
      const message = parts[4] ? parts[4].trim() : "";

      if (hash) {
        commits.push({
          hash,
          shortHash: shortHash || hash.slice(0, 7),
          message,
          ...(author ? { author } : {}),
          ...(date ? { date } : {}),
        });
      }
    }
  }

  return commits;
}

/**
 * Parses git diff --stat output into structured metrics and file lists.
 */
export function parseDiffStat(diffOutput: string): DiffStatResult {
  const result: DiffStatResult = {
    summaryText: "",
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    files: [],
  };

  if (!diffOutput || !diffOutput.trim()) {
    result.summaryText = "0 files changed";
    return result;
  }

  const rawLines = diffOutput.trim().split("\n");
  if (rawLines.length === 0) {
    return result;
  }

  // The last line is typically the summary line:
  // " 2 files changed, 35 insertions(+), 5 deletions(-)"
  const lastLine = rawLines[rawLines.length - 1]!.trim();
  const summaryMatch = lastLine.match(/(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/);

  if (summaryMatch) {
    result.summaryText = lastLine;
    result.filesChanged = parseInt(summaryMatch[1] ?? "0", 10);
    result.insertions = parseInt(summaryMatch[2] ?? "0", 10);
    result.deletions = parseInt(summaryMatch[3] ?? "0", 10);

    for (let i = 0; i < rawLines.length - 1; i++) {
      const line = rawLines[i]!.trim();
      const pipeIndex = line.indexOf("|");
      if (pipeIndex > 0) {
        const file = line.slice(0, pipeIndex).trim();
        const changes = line.slice(pipeIndex + 1).trim();
        if (file) {
          result.files.push({ file, changes });
        }
      }
    }
  } else {
    // If last line wasn't standard summary
    result.summaryText = lastLine;
    for (const line of rawLines) {
      const trimmed = line.trim();
      const pipeIndex = trimmed.indexOf("|");
      if (pipeIndex > 0) {
        const file = trimmed.slice(0, pipeIndex).trim();
        const changes = trimmed.slice(pipeIndex + 1).trim();
        if (file) {
          result.files.push({ file, changes });
        }
      }
    }
    result.filesChanged = result.files.length;
  }

  return result;
}

export interface EnsureReposConfigOptions {
  configPath?: string | undefined;
  workspaceRoot?: string | undefined;
  log?: {
    info: (msg: string, meta?: any) => void;
    warn: (msg: string, meta?: any) => void;
    error: (msg: string, meta?: any) => void;
  } | undefined;
}

export interface AutoDiscoveredRepoConfig {
  path: string;
  repoType: "code" | "system_knowledge" | "inbox";
  sourceBranch: string;
  knowledgeBranch?: string;
}

/**
 * Ensures a valid repository configuration file exists.
 * If target configuration file does not exist, scans workspace root for Git repositories
 * and auto-generates a standard repos.json file.
 */
export function ensureReposConfigFile(options?: EnsureReposConfigOptions): string | undefined {
  const targetPath =
    options?.configPath && typeof options.configPath === "string" && options.configPath.trim() !== ""
      ? path.resolve(options.configPath.trim())
      : "/etc/actiondock/repos.json";

  if (fs.existsSync(targetPath)) {
    return targetPath;
  }

  const rawWsRoot =
    (options?.workspaceRoot && options.workspaceRoot.trim()) ||
    (process.env.WORKSPACE_ROOT && process.env.WORKSPACE_ROOT.trim()) ||
    "/srv/workspace";

  const wsRoot = path.resolve(rawWsRoot);

  if (!fs.existsSync(wsRoot)) {
    return undefined;
  }

  try {
    const stat = fs.statSync(wsRoot);
    if (!stat.isDirectory()) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  const discovered: AutoDiscoveredRepoConfig[] = [];

  try {
    const entries = fs.readdirSync(wsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      let isDir = entry.isDirectory();
      if (!isDir && entry.isSymbolicLink()) {
        try {
          isDir = fs.statSync(path.join(wsRoot, entry.name)).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (isDir) {
        const subDirPath = path.join(wsRoot, entry.name);
        const gitDir = path.join(subDirPath, ".git");
        if (fs.existsSync(gitDir)) {
          const nameLower = entry.name.toLowerCase();
          if (nameLower.includes("system-knowledge") || nameLower.includes("knowledge-system")) {
            discovered.push({
              path: subDirPath,
              repoType: "system_knowledge",
              sourceBranch: "master",
            });
          } else if (nameLower.includes("inbox") || nameLower.includes("knowledge-inbox")) {
            discovered.push({
              path: subDirPath,
              repoType: "inbox",
              sourceBranch: "main",
            });
          } else {
            discovered.push({
              path: subDirPath,
              repoType: "code",
              sourceBranch: "release",
              knowledgeBranch: "docs",
            });
          }
        }
      }
    }
  } catch (err: any) {
    options?.log?.warn?.("Failed to scan workspace directory for repositories", {
      wsRoot,
      error: err?.message,
    });
    return undefined;
  }

  discovered.sort((a, b) => a.path.localeCompare(b.path));

  if (discovered.length === 0) {
    return undefined;
  }

  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify(discovered, null, 2) + "\n", "utf8");
    options?.log?.info?.("Auto-generated repository configuration file from workspace", {
      targetPath,
      count: discovered.length,
    });
    return targetPath;
  } catch (err: any) {
    options?.log?.warn?.("Failed to auto-generate repository configuration file", {
      targetPath,
      error: err?.message,
    });
    return undefined;
  }
}

