import fs from "node:fs";
import path from "node:path";
import { defineAction } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { KnowledgeInboxError } from "../src/errors.ts";
import {
  parseFrontmatter,
  extractCandidateYear,
  normalizeRepos,
  normalizeAuthor,
  VALID_RESOLUTIONS,
} from "../src/frontmatter.ts";
import { getInboxRoot, scanMarkdownFiles } from "../src/storage.ts";

export type Input = ActionInput<"knowledge.leaderboard">;
export type Output = ActionOutput<"knowledge.leaderboard">;

interface AuthorStats {
  author: string;
  totalCount: number;
  acceptedCount: number;
  pendingCount: number;
  rejectedCount: number;
  domainCounts: Map<string, number>;
}

function extractCandidateDate(
  data: Record<string, any>,
  id: string,
  baseName: string,
  birthtime?: Date
): Date | undefined {
  const rawCreatedAt = data.created_at ?? data.createdAt;
  if (rawCreatedAt) {
    if (rawCreatedAt instanceof Date && !isNaN(rawCreatedAt.getTime())) {
      return rawCreatedAt;
    }
    const str = String(rawCreatedAt).trim();
    const parsed = new Date(str);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const match = (id || baseName).match(/^(\d{4})(\d{2})(\d{2})/);
  if (match) {
    const y = parseInt(match[1], 10);
    const m = parseInt(match[2], 10) - 1;
    const d = parseInt(match[3], 10);
    return new Date(Date.UTC(y, m, d));
  }

  if (birthtime instanceof Date && !isNaN(birthtime.getTime())) {
    return birthtime;
  }

  return undefined;
}

export default defineAction<Input, Output>(async (input, ctx) => {
  const period = input.period ?? "all";
  if (period !== "all" && period !== "year" && period !== "month") {
    throw new KnowledgeInboxError(
      `Invalid period: '${input.period}'. Allowed values: all, year, month.`,
      "INVALID_PERIOD",
      400
    );
  }

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

  let limit = 10;
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

  const inboxRoot = getInboxRoot(ctx);
  const pendingDir = path.join(inboxRoot, "pending");
  const processedDir = path.join(inboxRoot, "processed");

  ctx.log.info("Starting knowledge.leaderboard", {
    period,
    year: filterYear,
    repo: filterRepo,
    limit,
    inboxRoot,
  });

  const filesToScan: string[] = [];
  const pendingFiles = await scanMarkdownFiles(pendingDir);
  filesToScan.push(...pendingFiles);

  const processedFiles = await scanMarkdownFiles(processedDir);
  filesToScan.push(...processedFiles);

  const now = new Date();
  const currentYear = now.getUTCFullYear().toString();
  const currentMonth = now.getUTCMonth();

  let totalSubmissions = 0;
  let totalAccepted = 0;
  let totalPending = 0;

  const authorMap = new Map<string, AuthorStats>();

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

      // 2. Determine year
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

      // Filter by period
      if (period === "year") {
        const targetYear = filterYear ?? currentYear;
        if (itemYear !== targetYear) {
          continue;
        }
      } else if (period === "month") {
        const targetYear = filterYear ?? currentYear;
        if (itemYear !== targetYear) {
          continue;
        }
        const docDate = extractCandidateDate(data, id, baseName, stat.birthtime);
        if (!docDate || docDate.getUTCMonth() !== currentMonth) {
          continue;
        }
      }

      // Filter by repo
      const candidateRepos = normalizeRepos(data.repos, data.repo);
      if (filterRepo && !candidateRepos.includes(filterRepo)) {
        continue;
      }

      // Determine resolution
      let resolution: string | undefined;
      if (
        typeof data.resolution === "string" &&
        VALID_RESOLUTIONS.has(data.resolution)
      ) {
        resolution = data.resolution;
      } else if (isUnderProcessed) {
        const relativeParts = path
          .relative(processedDir, filePath)
          .split(path.sep);
        if (relativeParts.length > 2 && VALID_RESOLUTIONS.has(relativeParts[1])) {
          resolution = relativeParts[1];
        } else if (relativeParts.length > 1 && VALID_RESOLUTIONS.has(relativeParts[0])) {
          resolution = relativeParts[0];
        }
      }

      // Overview accumulation within filtered scope
      totalSubmissions++;
      if (itemStatus === "pending") {
        totalPending++;
      } else if (itemStatus === "processed" && resolution === "accepted") {
        totalAccepted++;
      }

      // Author aggregation
      const author = normalizeAuthor(data.author);
      if (!author) {
        continue;
      }

      let stats = authorMap.get(author);
      if (!stats) {
        stats = {
          author,
          totalCount: 0,
          acceptedCount: 0,
          pendingCount: 0,
          rejectedCount: 0,
          domainCounts: new Map<string, number>(),
        };
        authorMap.set(author, stats);
      }

      stats.totalCount++;
      if (itemStatus === "pending") {
        stats.pendingCount++;
      } else if (itemStatus === "processed") {
        if (resolution === "accepted") {
          stats.acceptedCount++;
        } else if (
          resolution === "rejected" ||
          resolution === "duplicate" ||
          resolution === "insufficient_evidence"
        ) {
          stats.rejectedCount++;
        }
      }

      const domain =
        typeof data.domain === "string" && data.domain.trim()
          ? data.domain.trim()
          : undefined;
      if (domain) {
        stats.domainCounts.set(domain, (stats.domainCounts.get(domain) || 0) + 1);
      }
    } catch (err: any) {
      ctx.log.warn(`Skipping unreadable or corrupted file: ${filePath}`, {
        error: err.message,
      });
    }
  }

  // Calculate statistics and rank
  const contributors = Array.from(authorMap.values()).map((stats) => {
    const acceptanceRate =
      stats.totalCount === 0
        ? 0
        : Number((stats.acceptedCount / stats.totalCount).toFixed(2));

    const topDomains = Array.from(stats.domainCounts.entries())
      .sort((a, b) => {
        if (b[1] !== a[1]) {
          return b[1] - a[1];
        }
        return a[0].localeCompare(b[0]);
      })
      .slice(0, 3)
      .map(([d]) => d);

    return {
      author: stats.author,
      acceptedCount: stats.acceptedCount,
      totalCount: stats.totalCount,
      pendingCount: stats.pendingCount,
      rejectedCount: stats.rejectedCount,
      acceptanceRate,
      topDomains,
    };
  });

  // Rank sorting rules:
  // 1. acceptedCount descending
  // 2. acceptanceRate descending
  // 3. totalCount descending
  // 4. author ascending
  contributors.sort((a, b) => {
    if (b.acceptedCount !== a.acceptedCount) {
      return b.acceptedCount - a.acceptedCount;
    }
    if (b.acceptanceRate !== a.acceptanceRate) {
      return b.acceptanceRate - a.acceptanceRate;
    }
    if (b.totalCount !== a.totalCount) {
      return b.totalCount - a.totalCount;
    }
    return a.author.localeCompare(b.author);
  });

  const totalContributors = contributors.length;

  const leaderboard: Output["leaderboard"] = contributors
    .slice(0, limit)
    .map((c, index) => ({
      rank: index + 1,
      author: c.author,
      acceptedCount: c.acceptedCount,
      totalCount: c.totalCount,
      pendingCount: c.pendingCount,
      rejectedCount: c.rejectedCount,
      acceptanceRate: c.acceptanceRate,
      topDomains: c.topDomains,
    }));

  const overview: Output["overview"] = {
    totalContributors,
    totalSubmissions,
    totalAccepted,
    totalPending,
  };

  ctx.log.info("Completed knowledge.leaderboard", {
    totalContributors,
    totalSubmissions,
    totalAccepted,
    totalPending,
    returnedCount: leaderboard.length,
  });

  return {
    leaderboard,
    overview,
  };
});
