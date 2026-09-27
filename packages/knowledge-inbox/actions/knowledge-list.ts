import fs from "node:fs";
import path from "node:path";
import { defineAction } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { KnowledgeInboxError } from "../src/errors.ts";
import {
  parseFrontmatter,
  extractFirstHeading,
  extractCandidateYear,
  normalizeRepos,
  VALID_RESOLUTIONS,
} from "../src/frontmatter.ts";
import { getInboxRoot, scanMarkdownFiles } from "../src/storage.ts";

export type Input = ActionInput<"knowledge.list">;
export type Output = ActionOutput<"knowledge.list">;

export default defineAction<Input, Output>(async (input, ctx) => {
  const filterStatus = input.status ?? "pending";
  let filterYear: string | undefined;
  if (input.year !== undefined && input.year !== null) {
    const trimmedYear = String(input.year).trim();
    if (trimmedYear) {
      if (!/^\d{4}$/.test(trimmedYear)) {
        throw new KnowledgeInboxError(
          `Invalid year: '${input.year}'. Must be a 4-digit year (e.g. '2026').`,
          "INVALID_YEAR",
          400
        );
      }
      filterYear = trimmedYear;
    }
  }

  let filterRepo: string | undefined;
  if (input.repo !== undefined && input.repo !== null) {
    const trimmedRepo = String(input.repo).trim();
    if (trimmedRepo) {
      filterRepo = trimmedRepo;
    }
  }

  const inboxRoot = getInboxRoot(ctx);
  const pendingDir = path.join(inboxRoot, "pending");
  const processedDir = path.join(inboxRoot, "processed");

  ctx.log.info("Starting knowledge.list", {
    filterStatus,
    filterYear,
    filterRepo,
    inboxRoot,
  });

  const filesToScan: string[] = [];

  if (filterStatus === "pending" || filterStatus === "all") {
    const pendingFiles = await scanMarkdownFiles(pendingDir);
    filesToScan.push(...pendingFiles);
  }

  if (filterStatus === "processed" || filterStatus === "all") {
    if (filterYear) {
      const yearDir = path.join(processedDir, filterYear);
      const processedFiles = await scanMarkdownFiles(yearDir);
      filesToScan.push(...processedFiles);
    } else {
      const processedFiles = await scanMarkdownFiles(processedDir);
      filesToScan.push(...processedFiles);
    }
  }

  const items: Output["items"] = [];

  for (const filePath of filesToScan) {
    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const stat = await fs.promises.stat(filePath);
      const parsed = parseFrontmatter(content);
      const data = parsed.data || {};

      const baseName = path.basename(filePath);
      const isUnderProcessed =
        filePath.startsWith(processedDir + path.sep) || data.status === "processed";

      // 1. Determine ID
      let id = "";
      if (data.id && typeof data.id === "string") {
        id = data.id.trim();
      } else {
        // Fallback: extract ID from standard filename pattern
        // e.g. 20260924-112345-a1b2c3-foo.md -> 20260924-a1b2c3
        const filenameMatch = baseName.match(/^(\d{8})-\d{6}-([0-9a-fA-F]+)-/);
        if (filenameMatch) {
          id = `${filenameMatch[1]}-${filenameMatch[2]}`;
        } else {
          id = path.basename(filePath, ".md");
        }
      }

      // 2. Determine title
      let title: string | undefined;
      if (typeof data.title === "string" && data.title.trim()) {
        title = data.title.trim();
      } else {
        title = extractFirstHeading(parsed.body);
      }

      // 3. Determine domain
      const domain =
        typeof data.domain === "string" && data.domain.trim()
          ? data.domain.trim()
          : undefined;

      // 4. Determine tags
      let tags: string[] | undefined;
      if (Array.isArray(data.tags)) {
        tags = data.tags.map((t) => String(t).trim()).filter(Boolean);
      } else if (typeof data.tags === "string" && data.tags.trim()) {
        tags = [data.tags.trim()];
      }

      // 5. Determine creation and archive timestamps
      const birthtime =
        stat.birthtime instanceof Date && !isNaN(stat.birthtime.getTime())
          ? stat.birthtime.toISOString()
          : undefined;
      const createdAt =
        (typeof data.created_at === "string" && data.created_at) ||
        (typeof data.createdAt === "string" && data.createdAt) ||
        birthtime;

      const archivedAt =
        (typeof data.archived_at === "string" && data.archived_at) ||
        (typeof data.archivedAt === "string" && data.archivedAt) ||
        undefined;

      // 6. Determine resolution
      let resolution: Output["items"][number]["resolution"] | undefined;
      if (
        typeof data.resolution === "string" &&
        VALID_RESOLUTIONS.has(data.resolution)
      ) {
        resolution = data.resolution as Output["items"][number]["resolution"];
      } else if (isUnderProcessed) {
        // Check directory hierarchy e.g. processed/<year>/<resolution>/... or processed/<resolution>/...
        const relativeParts = path
          .relative(processedDir, filePath)
          .split(path.sep);
        if (relativeParts.length > 2 && VALID_RESOLUTIONS.has(relativeParts[1])) {
          resolution = relativeParts[1] as Output["items"][number]["resolution"];
        } else if (relativeParts.length > 1 && VALID_RESOLUTIONS.has(relativeParts[0])) {
          resolution = relativeParts[0] as Output["items"][number]["resolution"];
        }
      }

      // 7. Determine archive note
      const archiveNote =
        (typeof data.archive_note === "string" && data.archive_note.trim()) ||
        (typeof data.archiveNote === "string" && data.archiveNote.trim()) ||
        undefined;

      // 8. Determine year
      let itemYear: string | undefined;
      if (isUnderProcessed && filePath.startsWith(processedDir + path.sep)) {
        const relativeParts = path
          .relative(processedDir, filePath)
          .split(path.sep);
        if (relativeParts.length > 1 && /^\d{4}$/.test(relativeParts[0])) {
          itemYear = relativeParts[0];
        }
      }
      if (!itemYear) {
        itemYear = extractCandidateYear(
          data,
          id,
          stat.birthtime instanceof Date && !isNaN(stat.birthtime.getTime())
            ? stat.birthtime
            : undefined
        );
      }
      // Filter by year if specified
      if (filterYear && itemYear !== filterYear) {
        continue;
      }

      // Extract candidate repos
      const candidateRepos = normalizeRepos(data.repos, data.repo);

      // Filter by repo if specified
      if (filterRepo && !candidateRepos.includes(filterRepo)) {
        continue;
      }

      const item: Output["items"][number] = {
        id,
        filename: baseName,
        path: path.resolve(filePath),
        status: isUnderProcessed ? "processed" : "pending",
        ...(itemYear ? { year: itemYear } : {}),
        ...(title ? { title } : {}),
        ...(domain ? { domain } : {}),
        ...(tags && tags.length > 0 ? { tags } : {}),
        ...(candidateRepos.length > 0 ? { repos: candidateRepos } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(archivedAt ? { archivedAt } : {}),
        ...(resolution ? { resolution } : {}),
        ...(archiveNote ? { archiveNote } : {}),
      };

      items.push(item);
    } catch (err: any) {
      ctx.log.warn(`Skipping unreadable or corrupted file: ${filePath}`, {
        error: err.message,
      });
    }
  }

  // Sort descending by creation timestamp
  items.sort((a, b) => {
    const timeA = a.createdAt ? Date.parse(a.createdAt) : 0;
    const timeB = b.createdAt ? Date.parse(b.createdAt) : 0;
    if (timeA !== timeB && !Number.isNaN(timeA) && !Number.isNaN(timeB)) {
      return timeB - timeA;
    }
    return b.filename.localeCompare(a.filename);
  });

  ctx.log.info("Completed knowledge.list", {
    filterStatus,
    filterYear,
    filterRepo,
    count: items.length,
  });

  return { items };
});
