import crypto from "node:crypto";
import path from "node:path";
import YAML from "yaml";

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export interface ParsedMarkdown {
  data: Record<string, any>;
  body: string;
  hasFrontmatter: boolean;
}

/**
 * Strips UTF-8 BOM if present
 */
export function stripBom(str: string): string {
  if (str.charCodeAt(0) === 0xfeff) {
    return str.slice(1);
  }
  return str;
}

/**
 * Parse frontmatter from markdown string.
 * Retains all original fields and extracts remaining body.
 */
export function parseFrontmatter(rawContent: string): ParsedMarkdown {
  const content = stripBom(rawContent);
  const match = content.match(FRONTMATTER_REGEX);

  if (!match) {
    return {
      data: {},
      body: content,
      hasFrontmatter: false,
    };
  }

  const rawYaml = match[1];
  const body = content.slice(match[0].length);

  try {
    const parsed = YAML.parse(rawYaml);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        data: parsed as Record<string, any>,
        body,
        hasFrontmatter: true,
      };
    }
  } catch {
    // If YAML parsing fails, proceed with empty data and entire content as body
  }

  return {
    data: {},
    body,
    hasFrontmatter: true,
  };
}

/**
 * Extract the first H1 heading from markdown text if available
 */
export function extractFirstHeading(content: string): string | undefined {
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch && headingMatch[1]) {
    const firstLine = headingMatch[1].split(/\r?\n|\\n/)[0];
    return firstLine.trim();
  }
  return undefined;
}

/**
 * Sanitize a string into a safe filename slug.
 * Strictly prevents path traversal and removes unsafe characters.
 */
export function sanitizeSlug(input?: string): string {
  if (!input) return "";

  // 1. Strip directory components
  let slug = path.basename(input.trim());

  // 2. Remove markdown extensions
  slug = slug.replace(/\.(md|markdown)$/i, "");

  // 3. Keep alphanumeric, Chinese characters, hyphens and underscores
  slug = slug
    .replace(/[\\\/]/g, "")
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");

  return slug;
}

/**
 * Generate a unique candidate ID and timestamp components
 * ID format: YYYYMMDD-<6 hex chars>, e.g. 20260924-a1b2c3
 */
export function generateCandidateId(date: Date = new Date()): {
  id: string;
  datePart: string;
  timePart: string;
  shortHash: string;
} {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");

  const datePart = `${yyyy}${mm}${dd}`;
  const timePart = `${hh}${min}${ss}`;
  const shortHash = crypto.randomBytes(3).toString("hex").toLowerCase();
  const id = `${datePart}-${shortHash}`;

  return { id, datePart, timePart, shortHash };
}

/**
 * Build the standardized candidate filename:
 * <YYYYMMDD-HHmmss>-<shortId>-<safeSlug>.md
 */
export function buildCandidateFilename(
  datePart: string,
  timePart: string,
  shortId: string,
  safeSlug: string
): string {
  const cleanSlug = safeSlug.trim() || "candidate";
  return `${datePart}-${timePart}-${shortId}-${cleanSlug}.md`;
}

/**
 * Serialize metadata and body into standard frontmatter markdown.
 */
export function serializeMarkdownWithFrontmatter(
  data: Record<string, any>,
  body: string
): string {
  const yamlString = YAML.stringify(data).trim();
  const cleanBody = body.replace(/^\r?\n+/, "");
  return `---\n${yamlString}\n---\n\n${cleanBody}\n`;
}

/**
 * Extract 4-digit calendar year from candidate metadata or ID prefix.
 * Priority: candidate createdAt -> candidate id prefix -> fallback to current UTC year
 */
export function extractCandidateYear(
  candidateData?: Record<string, any>,
  fallbackId?: string,
  now: Date = new Date()
): string {
  // 1. Candidate createdAt / created_at
  const rawCreatedAt = candidateData?.created_at ?? candidateData?.createdAt;
  if (rawCreatedAt) {
    if (rawCreatedAt instanceof Date && !isNaN(rawCreatedAt.getTime())) {
      return rawCreatedAt.getUTCFullYear().toString();
    }
    const str = String(rawCreatedAt).trim();
    const match = str.match(/^(\d{4})/);
    if (match) {
      return match[1];
    }
    const parsedDate = new Date(str);
    if (!isNaN(parsedDate.getTime())) {
      return parsedDate.getUTCFullYear().toString();
    }
  }

  // 2. Candidate id prefix (first 4 digits)
  const rawId = candidateData?.id ?? fallbackId;
  if (rawId) {
    const idStr = String(rawId).trim();
    const match = idStr.match(/^(\d{4})/);
    if (match) {
      return match[1];
    }
  }

  // 3. Fallback to current UTC year
  return now.getUTCFullYear().toString();
}

/**
 * Parse and normalize repository identifiers from strings or arrays.
 * Handles single strings, comma-separated strings, and string arrays.
 */
export function parseRepoList(source: unknown): string[] {
  if (Array.isArray(source)) {
    return source
      .flatMap((item) => {
        if (typeof item === "string") return item.split(",");
        if (typeof item === "number" || typeof item === "boolean") return [String(item)];
        return [];
      })
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (typeof source === "string") {
    return source
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

/**
 * Extract deduplicated repository identifiers from candidate metadata.
 * Merges frontmatter repos and legacy repo fields.
 */
export function normalizeRepos(fmRepos?: unknown, fmRepo?: unknown): string[] {
  const fmList = [...parseRepoList(fmRepos), ...parseRepoList(fmRepo)];
  return Array.from(new Set(fmList));
}

/**
 * Valid archive resolutions shared by knowledge.list and knowledge.archive.
 */
export const VALID_RESOLUTIONS = new Set([
  "accepted",
  "duplicate",
  "rejected",
  "insufficient_evidence",
]);

