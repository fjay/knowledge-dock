import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseFrontmatter,
  stripBom,
  extractFirstHeading,
  sanitizeSlug,
  generateCandidateId,
  buildCandidateFilename,
  serializeMarkdownWithFrontmatter,
  extractCandidateYear,
  parseRepoList,
  normalizeRepos,
  normalizeAuthor,
} from "../src/frontmatter.ts";

describe("frontmatter utilities", () => {
  it("stripBom removes UTF-8 BOM", () => {
    const withBom = "\uFEFF# Title";
    assert.equal(stripBom(withBom), "# Title");
    assert.equal(stripBom("# No BOM"), "# No BOM");
  });

  it("parseFrontmatter parses markdown with standard YAML frontmatter", () => {
    const raw = `---
title: Test Title
domain: devops
tags:
  - k8s
  - docker
---

# Test Title
This is body text.`;

    const parsed = parseFrontmatter(raw);
    assert.equal(parsed.hasFrontmatter, true);
    assert.equal(parsed.data.title, "Test Title");
    assert.equal(parsed.data.domain, "devops");
    assert.deepEqual(parsed.data.tags, ["k8s", "docker"]);
    assert.match(parsed.body, /# Test Title/);
  });

  it("parseFrontmatter handles markdown without frontmatter", () => {
    const raw = "# Just a Title\n\nNo frontmatter here.";
    const parsed = parseFrontmatter(raw);
    assert.equal(parsed.hasFrontmatter, false);
    assert.deepEqual(parsed.data, {});
    assert.equal(parsed.body, raw);
  });

  it("parseFrontmatter handles invalid YAML gracefully", () => {
    const raw = `---
invalid: [unclosed array
---

Body content`;
    const parsed = parseFrontmatter(raw);
    assert.equal(parsed.hasFrontmatter, true);
    assert.deepEqual(parsed.data, {});
    assert.match(parsed.body, /Body content/);
  });

  it("extractFirstHeading extracts first H1", () => {
    assert.equal(extractFirstHeading("# Main Heading\nParagraph"), "Main Heading");
    assert.equal(extractFirstHeading("Text\n## Sub\n# Real Heading"), "Real Heading");
    assert.equal(extractFirstHeading("No headings here"), undefined);
  });

  it("sanitizeSlug cleans filenames and prevents path traversal", () => {
    assert.equal(sanitizeSlug("../../etc/passwd"), "passwd");
    assert.equal(sanitizeSlug("My Cool Document!.md"), "My-Cool-Document");
    assert.equal(sanitizeSlug("redis_cache_bug"), "redis_cache_bug");
    assert.equal(sanitizeSlug("排障记录-2026"), "排障记录-2026");
    assert.equal(sanitizeSlug("///"), "");
    assert.equal(sanitizeSlug(""), "");
    assert.equal(sanitizeSlug(undefined), "");
  });

  it("generateCandidateId produces valid YYYYMMDD-hash format", () => {
    const d = new Date(2026, 8, 24, 11, 23, 45); // Sept 24, 2026
    const res = generateCandidateId(d);
    assert.equal(res.datePart, "20260924");
    assert.equal(res.timePart, "112345");
    assert.match(res.shortHash, /^[0-9a-f]{6}$/);
    assert.equal(res.id, `20260924-${res.shortHash}`);
  });

  it("buildCandidateFilename constructs standard filename", () => {
    const filename = buildCandidateFilename("20260924", "112345", "a1b2c3", "redis-fix");
    assert.equal(filename, "20260924-112345-a1b2c3-redis-fix.md");
  });

  it("serializeMarkdownWithFrontmatter formats markdown properly", () => {
    const data = {
      title: "Sample",
      id: "20260924-a1b2c3",
      status: "pending",
    };
    const body = "Some body content\nLine 2";
    const serialized = serializeMarkdownWithFrontmatter(data, body);
    assert.match(serialized, /^---\ntitle: Sample/);
    assert.match(serialized, /id: 20260924-a1b2c3/);
    assert.match(serialized, /Some body content/);
  });

  it("extractCandidateYear prioritizes createdAt, then id prefix, then fallback to current year", () => {
    // 1. From created_at ISO string
    assert.equal(
      extractCandidateYear({ created_at: "2026-09-24T11:23:45.000Z" }),
      "2026"
    );
    // 2. From createdAt date string
    assert.equal(
      extractCandidateYear({ createdAt: "2025/05/10" }),
      "2025"
    );
    // 3. From Date object
    assert.equal(
      extractCandidateYear({ created_at: new Date(Date.UTC(2023, 0, 1)) }),
      "2023"
    );
    // 4. From id prefix when no createdAt
    assert.equal(
      extractCandidateYear({ id: "20240901-abc123" }),
      "2024"
    );
    // 5. Priority: createdAt takes precedence over id prefix
    assert.equal(
      extractCandidateYear(
        { created_at: "2023-01-01", id: "20260924-abc123" }
      ),
      "2023"
    );
    // 6. Fallback to fallbackId
    assert.equal(
      extractCandidateYear(undefined, "20220101-xyz"),
      "2022"
    );
    // 7. Fallback to now (current UTC year)
    const mockNow = new Date(Date.UTC(2030, 5, 1));
    assert.equal(
      extractCandidateYear(undefined, "unknown-id", mockNow),
      "2030"
    );
  });

  it("parseRepoList handles arrays, comma-separated strings, numbers, and cleans whitespace", () => {
    assert.deepEqual(parseRepoList(["order-service", "payment-service"]), [
      "order-service",
      "payment-service",
    ]);
    assert.deepEqual(parseRepoList("order-service, payment-service , auth"), [
      "order-service",
      "payment-service",
      "auth",
    ]);
    assert.deepEqual(parseRepoList(["order-service, payment-service", "gateway"]), [
      "order-service",
      "payment-service",
      "gateway",
    ]);
    assert.deepEqual(parseRepoList(null), []);
    assert.deepEqual(parseRepoList(undefined), []);
    assert.deepEqual(parseRepoList("   "), []);
    assert.deepEqual(parseRepoList(["  ", ""]), []);
  });

  it("normalizeRepos deduplicates repos and handles array and legacy frontmatter fallback", () => {
    // 1. Frontmatter repos array
    assert.deepEqual(
      normalizeRepos(["order-service", "payment-service"], undefined),
      ["order-service", "payment-service"]
    );
    // 2. Legacy single repo string frontmatter
    assert.deepEqual(normalizeRepos(undefined, "order-service"), ["order-service"]);
    // 3. Legacy comma-separated repo string frontmatter
    assert.deepEqual(
      normalizeRepos(undefined, "order-service, payment-service"),
      ["order-service", "payment-service"]
    );
    // 4. Combined frontmatter repos and legacy repo deduplicated
    assert.deepEqual(
      normalizeRepos(["order-service"], "order-service, payment-service"),
      ["order-service", "payment-service"]
    );
    // 5. No repos returns empty array
    assert.deepEqual(normalizeRepos(undefined, undefined), []);
  });

  it("normalizeAuthor cleans whitespace, converts to lowercase, and returns undefined for empty or invalid inputs", () => {
    assert.equal(normalizeAuthor(" Jay.Wu "), "jay.wu");
    assert.equal(normalizeAuthor("JAY.WU"), "jay.wu");
    assert.equal(normalizeAuthor("  Alice  "), "alice");
    assert.equal(normalizeAuthor(""), undefined);
    assert.equal(normalizeAuthor("   "), undefined);
    assert.equal(normalizeAuthor(null), undefined);
    assert.equal(normalizeAuthor(undefined), undefined);
    assert.equal(normalizeAuthor(123), undefined);
    assert.equal(normalizeAuthor({}), undefined);
    assert.equal(normalizeAuthor([]), undefined);
  });
});
