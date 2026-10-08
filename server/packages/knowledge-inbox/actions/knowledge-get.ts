import fs from "node:fs";
import path from "node:path";
import { defineAction, type ActionContext } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { KnowledgeInboxError } from "../src/errors.ts";
import {
  extractFirstHeading,
  extractCandidateYear,
  normalizeRepos,
  normalizeAuthor,
  VALID_RESOLUTIONS,
} from "../src/frontmatter.ts";
import { getInboxRoot, findCandidate } from "../src/storage.ts";

export type Input = ActionInput<"knowledge.get">;
export type Output = ActionOutput<"knowledge.get">;

export async function executeKnowledgeGet(
  input: { id?: string; path?: string; status?: "pending" | "processed" | "all" },
  ctx: ActionContext
): Promise<Output> {
  const filterStatus = input.status ?? "all";
  if (filterStatus !== "pending" && filterStatus !== "processed" && filterStatus !== "all") {
    throw new KnowledgeInboxError(
      `Invalid status: '${input.status}'. Allowed values: pending, processed, all.`,
      "INVALID_STATUS",
      400
    );
  }

  const rawId = input.id ? String(input.id).trim() : undefined;
  const rawPath = input.path ? String(input.path).trim() : undefined;

  if (!rawId && !rawPath) {
    throw new KnowledgeInboxError(
      "Document identifier (id or path) is required.",
      "IDENTIFIER_REQUIRED",
      400
    );
  }

  const inboxRoot = getInboxRoot(ctx);

  ctx.log.info("Starting knowledge retrieval", {
    id: rawId,
    path: rawPath,
    status: filterStatus,
    inboxRoot,
  });

  const match = await findCandidate(inboxRoot, {
    ...(rawId !== undefined ? { id: rawId } : {}),
    ...(rawPath !== undefined ? { path: rawPath } : {}),
    status: filterStatus,
  });

  if (!match) {
    const targetIdentifier = rawId || rawPath;
    throw new KnowledgeInboxError(
      `Candidate document not found for identifier: '${targetIdentifier}'.`,
      "DOCUMENT_NOT_FOUND",
      404
    );
  }

  const { filePath, filename, status, frontmatter, content } = match;
  const stat = await fs.promises.stat(filePath);
  const data = frontmatter.data || {};
  const processedDir = path.join(inboxRoot, "processed");
  const isUnderProcessed = status === "processed";

  // 1. Determine ID
  let id = "";
  if (data.id && typeof data.id === "string") {
    id = data.id.trim();
  } else {
    const filenameMatch = filename.match(/^(\d{8})-\d{6}-([0-9a-fA-F]+)-/);
    if (filenameMatch) {
      id = `${filenameMatch[1]}-${filenameMatch[2]}`;
    } else {
      id = path.basename(filename, ".md");
    }
  }

  // 2. Determine title
  let title: string | undefined;
  if (typeof data.title === "string" && data.title.trim()) {
    title = data.title.trim();
  } else {
    title = extractFirstHeading(frontmatter.body);
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

  // 5. Determine repos
  const repos = normalizeRepos(data.repos, data.repo);

  // 6. Determine author
  const author = normalizeAuthor(data.author);

  // 7. Determine timestamps
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

  // 8. Determine resolution
  let resolution: Output["resolution"] | undefined;
  if (
    typeof data.resolution === "string" &&
    VALID_RESOLUTIONS.has(data.resolution)
  ) {
    resolution = data.resolution as Output["resolution"];
  } else if (isUnderProcessed) {
    const relativeParts = path
      .relative(processedDir, filePath)
      .split(path.sep);
    if (relativeParts.length > 2 && VALID_RESOLUTIONS.has(relativeParts[1])) {
      resolution = relativeParts[1] as Output["resolution"];
    } else if (relativeParts.length > 1 && VALID_RESOLUTIONS.has(relativeParts[0])) {
      resolution = relativeParts[0] as Output["resolution"];
    }
  }

  // 9. Determine archive note
  const archiveNote =
    (typeof data.archive_note === "string" && data.archive_note.trim()) ||
    (typeof data.archiveNote === "string" && data.archiveNote.trim()) ||
    undefined;

  // 10. Determine year
  let year: string | undefined;
  if (isUnderProcessed && filePath.startsWith(processedDir + path.sep)) {
    const relativeParts = path
      .relative(processedDir, filePath)
      .split(path.sep);
    if (relativeParts.length > 1 && /^\d{4}$/.test(relativeParts[0])) {
      year = relativeParts[0];
    }
  }
  if (!year) {
    year = extractCandidateYear(
      data,
      id,
      stat.birthtime instanceof Date && !isNaN(stat.birthtime.getTime())
        ? stat.birthtime
        : undefined
    );
  }

  ctx.log.info("Successfully retrieved knowledge document", {
    id,
    filename,
    path: filePath,
    status,
  });

  return {
    id,
    filename,
    path: path.resolve(filePath),
    status,
    content,
    body: frontmatter.body,
    ...(title ? { title } : {}),
    ...(domain ? { domain } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(repos.length > 0 ? { repos } : {}),
    ...(author ? { author } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(archivedAt ? { archivedAt } : {}),
    ...(resolution ? { resolution } : {}),
    ...(archiveNote ? { archiveNote } : {}),
    ...(year ? { year } : {}),
    ...(data && Object.keys(data).length > 0 ? { frontmatter: data } : {}),
  };
}

export default defineAction<Input, Output>(async (input, ctx) => {
  return await executeKnowledgeGet(input, ctx);
});
