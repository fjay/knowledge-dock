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
