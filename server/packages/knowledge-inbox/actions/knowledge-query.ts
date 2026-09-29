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
  normalizeAuthor,
  VALID_RESOLUTIONS,
} from "../src/frontmatter.ts";
import { getInboxRoot, scanMarkdownFiles } from "../src/storage.ts";

export type Input = ActionInput<"knowledge.query">;
export type Output = ActionOutput<"knowledge.query">;

export default defineAction<Input, Output>(async (input, ctx) => {
  const filterStatus = input.status ?? "all";
  if (filterStatus !== "pending" && filterStatus !== "processed" && filterStatus !== "all") {
    throw new KnowledgeInboxError(
      `Invalid status: '${input.status}'. Allowed values: pending, processed, all.`,
      "INVALID_STATUS",
      400
    );
  }

  let limit = 20;
  if (input.limit !== undefined && input.limit !== null) {
    const parsedLimit = Number(input.limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      throw new KnowledgeInboxError(
        `Invalid limit: '${input.limit}'. Must be a positive integer between 1 and 100.`,
        "INVALID_LIMIT",
        400
      );
    }
    limit = Math.min(parsedLimit, 100);
  }

  const filterId = input.id ? String(input.id).trim() : undefined;
  const filterKeyword = input.keyword ? String(input.keyword).trim().toLowerCase() : undefined;
  const filterAuthor = input.author ? normalizeAuthor(input.author) : undefined;
  const filterRepo = input.repo ? String(input.repo).trim() : undefined;

  const inboxRoot = getInboxRoot(ctx);
  const pendingDir = path.join(inboxRoot, "pending");
  const processedDir = path.join(inboxRoot, "processed");

  ctx.log.info("Starting knowledge.query", {
    filterId,
    filterKeyword,
    filterAuthor,
    filterRepo,
    filterStatus,
    limit,
    inboxRoot,
  });

  const filesToScan: string[] = [];

  if (filterStatus === "pending" || filterStatus === "all") {
    const pendingFiles = await scanMarkdownFiles(pendingDir);
    filesToScan.push(...pendingFiles);
  }

  if (filterStatus === "processed" || filterStatus === "all") {
    const processedFiles = await scanMarkdownFiles(processedDir);
    filesToScan.push(...processedFiles);
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
      const itemStatus = isUnderProcessed ? "processed" : "pending";

      if (filterStatus !== "all" && itemStatus !== filterStatus) {
        continue;
      }

      // 1. Determine ID
      let id = "";
      if (data.id && typeof data.id === "string") {
        id = data.id.trim();
      } else {
        const filenameMatch = baseName.match(/^(\d{8})-\d{6}-([0-9a-fA-F]+)-/);
        if (filenameMatch) {
          id = `${filenameMatch[1]}-${filenameMatch[2]}`;
        } else {
          id = path.basename(filePath, ".md");
        }
      }

      // Filter by ID or filename
      if (filterId) {
        const cleanFilterId = path.basename(filterId);
        const cleanFilterIdNoExt = cleanFilterId.endsWith(".md")
          ? cleanFilterId.slice(0, -3)
          : cleanFilterId;
        const baseNameNoExt = baseName.endsWith(".md") ? baseName.slice(0, -3) : baseName;

        const matchesId =
          id === filterId ||
          id === cleanFilterId ||
          id === cleanFilterIdNoExt ||
          baseName === filterId ||
          baseName === cleanFilterId ||
          baseNameNoExt === cleanFilterIdNoExt;

        if (!matchesId) {
          continue;
        }
      }

      // 2. Determine author
      const author = normalizeAuthor(data.author);
      if (filterAuthor) {
        if (!author || author !== filterAuthor) {
          continue;
        }
      }

      // 3. Determine repos
      const candidateRepos = normalizeRepos(data.repos, data.repo);
      if (filterRepo) {
        const matchesRepo =
          candidateRepos.includes(filterRepo) ||
          candidateRepos.some((r) => r.toLowerCase() === filterRepo.toLowerCase());
        if (!matchesRepo) {
          continue;
        }
      }

      // 4. Determine title
      let title: string | undefined;
      if (typeof data.title === "string" && data.title.trim()) {
        title = data.title.trim();
      } else {
        title = extractFirstHeading(parsed.body);
      }

      // 5. Determine domain
      const domain =
        typeof data.domain === "string" && data.domain.trim()
          ? data.domain.trim()
          : undefined;

      // 6. Determine tags
      let tags: string[] | undefined;
      if (Array.isArray(data.tags)) {
        tags = data.tags.map((t) => String(t).trim()).filter(Boolean);
      } else if (typeof data.tags === "string" && data.tags.trim()) {
        tags = [data.tags.trim()];
      }

      // 7. Determine archive note
      const archiveNote =
        (typeof data.archive_note === "string" && data.archive_note.trim()) ||
        (typeof data.archiveNote === "string" && data.archiveNote.trim()) ||
        undefined;

      // Filter by keyword: title, body, tags, archive_note
      if (filterKeyword) {
        const titleMatch = Boolean(title && title.toLowerCase().includes(filterKeyword));
        const bodyMatch = Boolean(parsed.body && parsed.body.toLowerCase().includes(filterKeyword));
        const tagsMatch = Boolean(tags && tags.some((t) => t.toLowerCase().includes(filterKeyword)));
        const noteMatch = Boolean(archiveNote && archiveNote.toLowerCase().includes(filterKeyword));

        if (!titleMatch && !bodyMatch && !tagsMatch && !noteMatch) {
          continue;
        }
      }

      // 8. Determine creation and archive timestamps
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

      // 9. Determine resolution
      let resolution: Output["items"][number]["resolution"] | undefined;
      if (
        typeof data.resolution === "string" &&
        VALID_RESOLUTIONS.has(data.resolution)
      ) {
        resolution = data.resolution as Output["items"][number]["resolution"];
      } else if (isUnderProcessed) {
        const relativeParts = path
          .relative(processedDir, filePath)
          .split(path.sep);
        if (relativeParts.length > 2 && VALID_RESOLUTIONS.has(relativeParts[1])) {
          resolution = relativeParts[1] as Output["items"][number]["resolution"];
        } else if (relativeParts.length > 1 && VALID_RESOLUTIONS.has(relativeParts[0])) {
          resolution = relativeParts[0] as Output["items"][number]["resolution"];
        }
      }

      // 10. Determine year
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

      const item: Output["items"][number] = {
        id,
        filename: baseName,
        path: path.resolve(filePath),
        status: itemStatus,
        ...(resolution ? { resolution } : {}),
        ...(archiveNote ? { archiveNote } : {}),
        ...(author ? { author } : {}),
        ...(title ? { title } : {}),
        ...(domain ? { domain } : {}),
        ...(tags && tags.length > 0 ? { tags } : {}),
        ...(candidateRepos.length > 0 ? { repos: candidateRepos } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(archivedAt ? { archivedAt } : {}),
        ...(itemYear ? { year: itemYear } : {}),
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

  const sliced = items.slice(0, limit);

  ctx.log.info("Completed knowledge.query", {
    filterId,
    filterKeyword,
    filterAuthor,
    filterRepo,
    filterStatus,
    limit,
    matchedCount: items.length,
    returnedCount: sliced.length,
  });

  return { items: sliced };
});
