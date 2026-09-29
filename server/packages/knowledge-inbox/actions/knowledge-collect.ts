import fs from "node:fs";
import path from "node:path";
import { defineAction } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { KnowledgeInboxError } from "../src/errors.ts";
import {
  parseFrontmatter,
  extractFirstHeading,
  sanitizeSlug,
  generateCandidateId,
  buildCandidateFilename,
  serializeMarkdownWithFrontmatter,
  normalizeRepos,
  normalizeAuthor,
} from "../src/frontmatter.ts";
import { getInboxRoot, ensureDirectory } from "../src/storage.ts";
import { commitCandidateCollect } from "../src/git.ts";

export type Input = ActionInput<"knowledge.collect">;
export type Output = ActionOutput<"knowledge.collect">;

export default defineAction<Input, Output>(async (input, ctx) => {
  ctx.log.info("Starting knowledge.collect", {
    suggestedFilename: input.filename,
    contentLength: input.content ? input.content.length : 0,
  });

  // 1. Validate content input
  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    throw new KnowledgeInboxError(
      "Document content must be a non-empty string.",
      "CONTENT_REQUIRED",
      400
    );
  }

  // 2. Resolve inbox storage root and ensure pending directory exists
  const inboxRoot = getInboxRoot(ctx);
  const pendingDir = path.join(inboxRoot, "pending");
  await ensureDirectory(pendingDir);

  // 3. Generate secure timestamp-based unique ID
  const now = new Date();
  const { id, datePart, timePart, shortHash } = generateCandidateId(now);
  const createdAtIso = now.toISOString();

  // 4. Parse incoming frontmatter and extract metadata
  const parsed = parseFrontmatter(input.content);
  const frontmatterData: Record<string, any> = { ...parsed.data };

  // Infer title if not explicitly set in frontmatter
  if (!frontmatterData.title) {
    const heading = extractFirstHeading(parsed.body);
    if (heading) {
      frontmatterData.title = heading;
    }
  }

  // Extract and normalize repos from markdown frontmatter (with legacy repo fallback)
  const repos = normalizeRepos(frontmatterData.repos, frontmatterData.repo);

  // Persist repos into frontmatter
  if (repos.length > 0) {
    frontmatterData.repos = repos;
  }
  delete frontmatterData.repo;

  // Normalize author if provided
  const author = normalizeAuthor(frontmatterData.author);
  if (author) {
    frontmatterData.author = author;
  } else {
    delete frontmatterData.author;
  }

  // Append/override server-managed metadata
  frontmatterData.id = id;
  frontmatterData.created_at = createdAtIso;
  frontmatterData.status = "pending";

  // 5. Derive safe filename slug
  let slug = sanitizeSlug(input.filename);
  if (!slug && frontmatterData.title) {
    slug = sanitizeSlug(String(frontmatterData.title));
  }
  if (!slug) {
    slug = "candidate";
  }

  const safeFilename = buildCandidateFilename(datePart, timePart, shortHash, slug);
  const targetFilePath = path.join(pendingDir, safeFilename);

  // 6. Serialize enriched markdown with frontmatter and write to disk
  const finalContent = serializeMarkdownWithFrontmatter(
    frontmatterData,
    parsed.body
  );

  await fs.promises.writeFile(targetFilePath, finalContent, "utf-8");

  await commitCandidateCollect(
    inboxRoot,
    safeFilename,
    id,
    String(frontmatterData.title || slug || "candidate"),
    ctx.log
  );

  ctx.log.info("Successfully collected knowledge candidate", {
    id,
    filename: safeFilename,
    path: targetFilePath,
    repos: repos.length > 0 ? repos : undefined,
  });

  return {
    id,
    filename: safeFilename,
    path: targetFilePath,
    status: "pending",
  };
});
