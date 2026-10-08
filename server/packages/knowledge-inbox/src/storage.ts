import fs from "node:fs";
import path from "node:path";
import type { ActionContext } from "@actiondock/sdk";
import { parseFrontmatter, type ParsedMarkdown } from "./frontmatter.ts";

export interface CandidateFileMatch {
  filePath: string;
  filename: string;
  frontmatter: ParsedMarkdown;
}

/**
 * Resolve root storage directory from ActionContext config or environment variable.
 */
export function getInboxRoot(ctx: ActionContext): string {
  const root = ctx.config.get<string>(
    "KNOWLEDGE_INBOX_ROOT",
    process.env.KNOWLEDGE_INBOX_ROOT || "/srv/knowledge-inbox"
  );
  return path.resolve(root);
}

/**
 * Ensure directory exists.
 */
export async function ensureDirectory(dirPath: string): Promise<string> {
  const resolved = path.resolve(dirPath);
  await fs.promises.mkdir(resolved, { recursive: true });
  return resolved;
}

/**
 * Recursively find all markdown files in a directory.
 * Returns empty array if directory does not exist.
 */
export async function scanMarkdownFiles(dirPath: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await scanMarkdownFiles(fullPath);
        results.push(...subFiles);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        results.push(fullPath);
      }
    }
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  return results;
}

/**
 * Find a candidate markdown file in the pending directory matching the given ID or filename.
 */
export async function findPendingCandidate(
  pendingDir: string,
  identifier: string
): Promise<CandidateFileMatch | null> {
  const cleanId = path.basename(identifier.trim());
  if (!cleanId) return null;

  let fileNames: string[];
  try {
    fileNames = await fs.promises.readdir(pendingDir);
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }

  const mdFiles = fileNames.filter((name) => name.toLowerCase().endsWith(".md"));

  // Pass 1: Exact filename match (e.g. "20260924-112345-a1b2c3-foo.md" or "20260924-112345-a1b2c3-foo")
  for (const name of mdFiles) {
    if (name === cleanId || name === `${cleanId}.md`) {
      const filePath = path.join(pendingDir, name);
      const content = await fs.promises.readFile(filePath, "utf-8");
      const frontmatter = parseFrontmatter(content);
      return { filePath, filename: name, frontmatter };
    }
  }

  // Pass 2: Exact frontmatter id match
  for (const name of mdFiles) {
    const filePath = path.join(pendingDir, name);
    let content: string;
    try {
      content = await fs.promises.readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    const parsed = parseFrontmatter(content);

    if (parsed.data && String(parsed.data.id).trim() === cleanId) {
      return { filePath, filename: name, frontmatter: parsed };
    }
  }

  return null;
}

export interface CandidateLookupMatch {
  filePath: string;
  filename: string;
  status: "pending" | "processed";
  frontmatter: ParsedMarkdown;
  content: string;
}

/**
 * Find a candidate markdown file across pending and processed directories by ID, filename, or direct path.
 */
export async function findCandidate(
  inboxRoot: string,
  identifier: { id?: string | undefined; path?: string | undefined; status?: "pending" | "processed" | "all" | undefined }
): Promise<CandidateLookupMatch | null> {
  const filterStatus = identifier.status ?? "all";
  const pendingDir = path.join(inboxRoot, "pending");
  const processedDir = path.join(inboxRoot, "processed");

  // 1. Direct path lookup
  const candidatePath = identifier.path?.trim() || (identifier.id?.includes(path.sep) || identifier.id?.includes("/") ? identifier.id.trim() : undefined);
  if (candidatePath) {
    const resolvedPath = path.isAbsolute(candidatePath)
      ? path.resolve(candidatePath)
      : path.resolve(inboxRoot, candidatePath);

    // Path boundary check against inboxRoot
    const relFromRoot = path.relative(inboxRoot, resolvedPath);
    if (relFromRoot === ".." || relFromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relFromRoot)) {
      const { KnowledgeInboxError } = await import("./errors.ts");
      throw new KnowledgeInboxError(
        `Path resolves outside inbox root: ${candidatePath}`,
        "PATH_OUTSIDE_INBOX",
        403
      );
    }

    if (fs.existsSync(resolvedPath)) {
      const realTarget = fs.realpathSync(resolvedPath);
      const realRoot = fs.existsSync(inboxRoot) ? fs.realpathSync(inboxRoot) : inboxRoot;
      const relFromRealRoot = path.relative(realRoot, realTarget);
      if (relFromRealRoot === ".." || relFromRealRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relFromRealRoot)) {
        const { KnowledgeInboxError } = await import("./errors.ts");
        throw new KnowledgeInboxError(
          `Symlink target resolves outside inbox root: ${candidatePath}`,
          "SYMLINK_OUTSIDE_INBOX",
          403
        );
      }

      const stat = await fs.promises.stat(realTarget);
      if (stat.isFile() && realTarget.toLowerCase().endsWith(".md")) {
        const content = await fs.promises.readFile(realTarget, "utf-8");
        const frontmatter = parseFrontmatter(content);
        const isUnderProcessed =
          realTarget.startsWith(processedDir + path.sep) || frontmatter.data?.status === "processed";
        const docStatus = isUnderProcessed ? "processed" : "pending";

        if (filterStatus !== "all" && docStatus !== filterStatus) {
          return null;
        }

        return {
          filePath: resolvedPath,
          filename: path.basename(resolvedPath),
          status: docStatus,
          frontmatter,
          content,
        };
      }
    }
  }

  // 2. ID / Filename lookup
  const rawId = identifier.id ? identifier.id.trim() : undefined;
  if (!rawId) {
    return null;
  }

  const cleanId = path.basename(rawId);
  const cleanIdNoExt = cleanId.endsWith(".md") ? cleanId.slice(0, -3) : cleanId;

  // Search pending directory
  if (filterStatus === "pending" || filterStatus === "all") {
    const pendingFiles = await scanMarkdownFiles(pendingDir);
    for (const filePath of pendingFiles) {
      const baseName = path.basename(filePath);
      const baseNameNoExt = baseName.endsWith(".md") ? baseName.slice(0, -3) : baseName;

      // Check quick filename match
      const quickMatch =
        baseName === cleanId ||
        baseName === `${cleanId}.md` ||
        baseNameNoExt === cleanIdNoExt;

      let content: string;
      try {
        content = await fs.promises.readFile(filePath, "utf-8");
      } catch {
        continue;
      }

      const frontmatter = parseFrontmatter(content);
      const data = frontmatter.data || {};

      let docId = "";
      if (data.id && typeof data.id === "string") {
        docId = data.id.trim();
      } else {
        const filenameMatch = baseName.match(/^(\d{8})-\d{6}-([0-9a-fA-F]+)-/);
        if (filenameMatch) {
          docId = `${filenameMatch[1]}-${filenameMatch[2]}`;
        } else {
          docId = baseNameNoExt;
        }
      }

      if (
        quickMatch ||
        docId === cleanId ||
        docId === cleanIdNoExt ||
        docId === rawId
      ) {
        return {
          filePath,
          filename: baseName,
          status: "pending",
          frontmatter,
          content,
        };
      }
    }
  }

  // Search processed directory
  if (filterStatus === "processed" || filterStatus === "all") {
    const processedFiles = await scanMarkdownFiles(processedDir);
    for (const filePath of processedFiles) {
      const baseName = path.basename(filePath);
      const baseNameNoExt = baseName.endsWith(".md") ? baseName.slice(0, -3) : baseName;

      const quickMatch =
        baseName === cleanId ||
        baseName === `${cleanId}.md` ||
        baseNameNoExt === cleanIdNoExt;

      let content: string;
      try {
        content = await fs.promises.readFile(filePath, "utf-8");
      } catch {
        continue;
      }

      const frontmatter = parseFrontmatter(content);
      const data = frontmatter.data || {};

      let docId = "";
      if (data.id && typeof data.id === "string") {
        docId = data.id.trim();
      } else {
        const filenameMatch = baseName.match(/^(\d{8})-\d{6}-([0-9a-fA-F]+)-/);
        if (filenameMatch) {
          docId = `${filenameMatch[1]}-${filenameMatch[2]}`;
        } else {
          docId = baseNameNoExt;
        }
      }

      if (
        quickMatch ||
        docId === cleanId ||
        docId === cleanIdNoExt ||
        docId === rawId
      ) {
        return {
          filePath,
          filename: baseName,
          status: "processed",
          frontmatter,
          content,
        };
      }
    }
  }

  return null;
}

