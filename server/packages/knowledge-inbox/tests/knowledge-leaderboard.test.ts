import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestRuntime } from "@actiondock/testing";
import leaderboardAction from "../actions/knowledge-leaderboard.ts";

describe("knowledge.leaderboard", () => {
  it("returns empty leaderboard and zero overview when inbox directories do not exist", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-lb-empty-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const result = await runtime.run(leaderboardAction, {});
      assert.deepEqual(result.leaderboard, []);
      assert.deepEqual(result.overview, {
        totalContributors: 0,
        totalSubmissions: 0,
        totalAccepted: 0,
        totalPending: 0,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid period with 400 error", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-lb-period-err-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      await assert.rejects(
        () => runtime.run(leaderboardAction, { period: "quarter" as any }),
        (err: any) => err.code === "INVALID_PERIOD"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid year with 400 error", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-lb-year-err-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      await assert.rejects(
        () => runtime.run(leaderboardAction, { year: "202" }),
        (err: any) => err.code === "INVALID_YEAR"
      );

      await assert.rejects(
        () => runtime.run(leaderboardAction, { year: "abcd" }),
        (err: any) => err.code === "INVALID_YEAR"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid limit with 400 error", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-lb-limit-err-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      await assert.rejects(
        () => runtime.run(leaderboardAction, { limit: 0 }),
        (err: any) => err.code === "INVALID_LIMIT"
      );

      await assert.rejects(
        () => runtime.run(leaderboardAction, { limit: -10 }),
        (err: any) => err.code === "INVALID_LIMIT"
      );

      await assert.rejects(
        () => runtime.run(leaderboardAction, { limit: 2.5 }),
        (err: any) => err.code === "INVALID_LIMIT"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("correctly ranks multiple contributors following 4-tier sorting rules", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-lb-rank-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const pendingDir = path.join(tmpDir, "pending");
      const processedDir = path.join(tmpDir, "processed", "2026");
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.mkdirSync(path.join(processedDir, "accepted"), { recursive: true });
      fs.mkdirSync(path.join(processedDir, "rejected"), { recursive: true });

      // Alice: 3 accepted, 0 pending, 0 rejected -> total 3, rate 1.0
      for (let i = 1; i <= 3; i++) {
        fs.writeFileSync(
          path.join(processedDir, "accepted", `20260901-alice-${i}.md`),
          `---\nid: 20260901-alice-${i}\nauthor: Alice\ndomain: infra\nstatus: processed\nresolution: accepted\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc`
        );
      }

      // Bob: 3 accepted, 1 rejected -> total 4, rate 0.75 (same accepted as Alice, but lower rate)
      for (let i = 1; i <= 3; i++) {
        fs.writeFileSync(
          path.join(processedDir, "accepted", `20260901-bob-acc-${i}.md`),
          `---\nid: 20260901-bob-acc-${i}\nauthor: bob\ndomain: db\nstatus: processed\nresolution: accepted\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc`
        );
      }
      fs.writeFileSync(
        path.join(processedDir, "rejected", "20260901-bob-rej-1.md"),
        `---\nid: 20260901-bob-rej-1\nauthor: bob\ndomain: db\nstatus: processed\nresolution: rejected\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc`
      );

      // Charlie: 2 accepted, 0 rejected -> total 2, rate 1.0 (acceptedCount 2 < 3)
      for (let i = 1; i <= 2; i++) {
        fs.writeFileSync(
          path.join(processedDir, "accepted", `20260901-charlie-${i}.md`),
          `---\nid: 20260901-charlie-${i}\nauthor: Charlie\ndomain: security\nstatus: processed\nresolution: accepted\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc`
        );
      }

      // David: 2 accepted, 2 pending -> total 4, rate 0.5 (same accepted as Charlie, but lower rate)
      for (let i = 1; i <= 2; i++) {
        fs.writeFileSync(
          path.join(processedDir, "accepted", `20260901-david-acc-${i}.md`),
          `---\nid: 20260901-david-acc-${i}\nauthor: david\ndomain: api\nstatus: processed\nresolution: accepted\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc`
        );
        fs.writeFileSync(
          path.join(pendingDir, `20260901-david-pen-${i}.md`),
          `---\nid: 20260901-david-pen-${i}\nauthor: david\ndomain: api\nstatus: pending\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc`
        );
      }

      // Eric: 0 accepted, 2 pending -> total 2, rate 0 (totalCount 2)
      for (let i = 1; i <= 2; i++) {
        fs.writeFileSync(
          path.join(pendingDir, `20260901-eric-${i}.md`),
          `---\nid: 20260901-eric-${i}\nauthor: eric\ndomain: frontend\nstatus: pending\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc`
        );
      }

      // Frank: 0 accepted, 1 pending -> total 1, rate 0
      fs.writeFileSync(
        path.join(pendingDir, "20260901-frank-1.md"),
        `---\nid: 20260901-frank-1\nauthor: frank\ndomain: devops\nstatus: pending\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc`
      );

      // George: 0 accepted, 1 pending -> total 1, rate 0 (same as frank, but frank < george alphabetically)
      fs.writeFileSync(
        path.join(pendingDir, "20260901-george-1.md"),
        `---\nid: 20260901-george-1\nauthor: george\ndomain: devops\nstatus: pending\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc`
      );

      const result = await runtime.run(leaderboardAction, { limit: 10 });

      assert.equal(result.leaderboard.length, 7);
      assert.equal(result.overview.totalContributors, 7);
      assert.equal(result.overview.totalSubmissions, 17);
      assert.equal(result.overview.totalAccepted, 10);
      assert.equal(result.overview.totalPending, 6);

      // Verify order: alice (rank 1), bob (rank 2), charlie (rank 3), david (rank 4), eric (rank 5), frank (rank 6), george (rank 7)
      const expectedAuthors = ["alice", "bob", "charlie", "david", "eric", "frank", "george"];
      for (let idx = 0; idx < expectedAuthors.length; idx++) {
        const item = result.leaderboard[idx];
        assert.equal(item.rank, idx + 1);
        assert.equal(item.author, expectedAuthors[idx]);
      }

      // Check alice detail
      assert.equal(result.leaderboard[0].acceptedCount, 3);
      assert.equal(result.leaderboard[0].totalCount, 3);
      assert.equal(result.leaderboard[0].pendingCount, 0);
      assert.equal(result.leaderboard[0].rejectedCount, 0);
      assert.equal(result.leaderboard[0].acceptanceRate, 1.0);

      // Check bob detail
      assert.equal(result.leaderboard[1].acceptedCount, 3);
      assert.equal(result.leaderboard[1].totalCount, 4);
      assert.equal(result.leaderboard[1].pendingCount, 0);
      assert.equal(result.leaderboard[1].rejectedCount, 1);
      assert.equal(result.leaderboard[1].acceptanceRate, 0.75);

      // Check david detail
      assert.equal(result.leaderboard[3].acceptedCount, 2);
      assert.equal(result.leaderboard[3].totalCount, 4);
      assert.equal(result.leaderboard[3].pendingCount, 2);
      assert.equal(result.leaderboard[3].rejectedCount, 0);
      assert.equal(result.leaderboard[3].acceptanceRate, 0.5);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("correctly calculates acceptance rate and rounds to two decimal places", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-lb-rate-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const pendingDir = path.join(tmpDir, "pending");
      const processedDir = path.join(tmpDir, "processed", "2026", "accepted");
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.mkdirSync(processedDir, { recursive: true });

      // 1 accepted, 2 pending -> 1/3 = 0.33
      fs.writeFileSync(
        path.join(processedDir, "20260901-user1-acc.md"),
        `---\nid: 20260901-user1-acc\nauthor: user1\nstatus: processed\nresolution: accepted\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc`
      );
      fs.writeFileSync(
        path.join(pendingDir, "20260901-user1-pen1.md"),
        `---\nid: 20260901-user1-pen1\nauthor: user1\nstatus: pending\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc`
      );
      fs.writeFileSync(
        path.join(pendingDir, "20260901-user1-pen2.md"),
        `---\nid: 20260901-user1-pen2\nauthor: user1\nstatus: pending\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc`
      );

      const result = await runtime.run(leaderboardAction, {});
      assert.equal(result.leaderboard.length, 1);
      assert.equal(result.leaderboard[0].acceptanceRate, 0.33);
      assert.equal(result.leaderboard[0].acceptedCount, 1);
      assert.equal(result.leaderboard[0].totalCount, 3);
      assert.equal(result.leaderboard[0].pendingCount, 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("filters candidate documents by repository", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-lb-repo-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const pendingDir = path.join(tmpDir, "pending");
      fs.mkdirSync(pendingDir, { recursive: true });

      fs.writeFileSync(
        path.join(pendingDir, "20260901-doc-repo-a.md"),
        `---\nid: 20260901-doc-repo-a\nauthor: alice\nrepos: [order-service]\nstatus: pending\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc A`
      );
      fs.writeFileSync(
        path.join(pendingDir, "20260901-doc-repo-b.md"),
        `---\nid: 20260901-doc-repo-b\nauthor: bob\nrepos: [user-service]\nstatus: pending\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc B`
      );

      const resFiltered = await runtime.run(leaderboardAction, { repo: "order-service" });
      assert.equal(resFiltered.leaderboard.length, 1);
      assert.equal(resFiltered.leaderboard[0].author, "alice");
      assert.equal(resFiltered.overview.totalContributors, 1);
      assert.equal(resFiltered.overview.totalSubmissions, 1);

      const resAll = await runtime.run(leaderboardAction, {});
      assert.equal(resAll.leaderboard.length, 2);
      assert.equal(resAll.overview.totalContributors, 2);
      assert.equal(resAll.overview.totalSubmissions, 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("filters candidate documents by calendar year", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-lb-year-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const pendingDir = path.join(tmpDir, "pending");
      fs.mkdirSync(pendingDir, { recursive: true });

      fs.writeFileSync(
        path.join(pendingDir, "20251010-doc-2025.md"),
        `---\nid: 20251010-doc-2025\nauthor: legacy-user\ncreated_at: '2025-10-10T00:00:00Z'\nstatus: pending\n---\n# 2025 Doc`
      );
      fs.writeFileSync(
        path.join(pendingDir, "20260901-doc-2026.md"),
        `---\nid: 20260901-doc-2026\nauthor: current-user\ncreated_at: '2026-09-01T00:00:00Z'\nstatus: pending\n---\n# 2026 Doc`
      );

      const res2026 = await runtime.run(leaderboardAction, { year: "2026" });
      assert.equal(res2026.leaderboard.length, 1);
      assert.equal(res2026.leaderboard[0].author, "current-user");
      assert.equal(res2026.overview.totalSubmissions, 1);

      const res2025 = await runtime.run(leaderboardAction, { year: "2025" });
      assert.equal(res2025.leaderboard.length, 1);
      assert.equal(res2025.leaderboard[0].author, "legacy-user");
      assert.equal(res2025.overview.totalSubmissions, 1);

      const resAll = await runtime.run(leaderboardAction, { period: "all" });
      assert.equal(resAll.leaderboard.length, 2);
      assert.equal(resAll.overview.totalSubmissions, 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("filters candidate documents by period (all, year, month)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-lb-period-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const pendingDir = path.join(tmpDir, "pending");
      fs.mkdirSync(pendingDir, { recursive: true });

      const now = new Date();
      const currentYear = now.getUTCFullYear();
      const currentMonth = String(now.getUTCMonth() + 1).padStart(2, "0");

      // Document 1: This month
      const docCurrentMonthDate = `${currentYear}-${currentMonth}-15T10:00:00Z`;
      fs.writeFileSync(
        path.join(pendingDir, "doc-curr-month.md"),
        `---\nid: ${currentYear}${currentMonth}15-a1b2c3\nauthor: user-month\ncreated_at: '${docCurrentMonthDate}'\nstatus: pending\n---\n# Current Month`
      );

      // Document 2: Different month in current year (e.g. month 01 if not month 01, else month 02)
      const diffMonth = now.getUTCMonth() === 0 ? "02" : "01";
      const docDiffMonthDate = `${currentYear}-${diffMonth}-15T10:00:00Z`;
      fs.writeFileSync(
        path.join(pendingDir, "doc-diff-month.md"),
        `---\nid: ${currentYear}${diffMonth}15-d4e5f6\nauthor: user-year\ncreated_at: '${docDiffMonthDate}'\nstatus: pending\n---\n# Other Month`
      );

      // Document 3: Previous year
      const prevYear = currentYear - 1;
      fs.writeFileSync(
        path.join(pendingDir, "doc-prev-year.md"),
        `---\nid: ${prevYear}0515-g7h8i9\nauthor: user-prev-year\ncreated_at: '${prevYear}-05-15T10:00:00Z'\nstatus: pending\n---\n# Previous Year`
      );

      // 1. period: month -> only doc 1
      const resMonth = await runtime.run(leaderboardAction, { period: "month" });
      assert.equal(resMonth.leaderboard.length, 1);
      assert.equal(resMonth.leaderboard[0].author, "user-month");
      assert.equal(resMonth.overview.totalSubmissions, 1);

      // 2. period: year -> doc 1 and doc 2
      const resYear = await runtime.run(leaderboardAction, { period: "year" });
      assert.equal(resYear.leaderboard.length, 2);
      const yearAuthors = resYear.leaderboard.map((i) => i.author).sort();
      assert.deepEqual(yearAuthors, ["user-month", "user-year"]);
      assert.equal(resYear.overview.totalSubmissions, 2);

      // 3. period: all -> doc 1, doc 2, and doc 3
      const resAll = await runtime.run(leaderboardAction, { period: "all" });
      assert.equal(resAll.leaderboard.length, 3);
      assert.equal(resAll.overview.totalSubmissions, 3);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("truncates leaderboard by limit while keeping total overview counts accurate", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-lb-limit-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const pendingDir = path.join(tmpDir, "pending");
      fs.mkdirSync(pendingDir, { recursive: true });

      // Create 5 authors with 1 submission each
      for (let i = 1; i <= 5; i++) {
        fs.writeFileSync(
          path.join(pendingDir, `20260901-user-${i}.md`),
          `---\nid: 20260901-user-${i}\nauthor: user-${i}\nstatus: pending\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc`
        );
      }

      const result = await runtime.run(leaderboardAction, { limit: 2 });
      assert.equal(result.leaderboard.length, 2);
      assert.equal(result.leaderboard[0].rank, 1);
      assert.equal(result.leaderboard[1].rank, 2);

      // Overview should reflect all 5 contributors
      assert.equal(result.overview.totalContributors, 5);
      assert.equal(result.overview.totalSubmissions, 5);
      assert.equal(result.overview.totalPending, 5);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("excludes submissions without author from personal leaderboard while counting in overview", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-lb-no-author-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const pendingDir = path.join(tmpDir, "pending");
      const processedDir = path.join(tmpDir, "processed", "2026", "accepted");
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.mkdirSync(processedDir, { recursive: true });

      // Doc with valid author
      fs.writeFileSync(
        path.join(processedDir, "20260901-has-author.md"),
        `---\nid: 20260901-has-author\nauthor: alice\nstatus: processed\nresolution: accepted\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc with author`
      );

      // Doc without author in frontmatter
      fs.writeFileSync(
        path.join(pendingDir, "20260901-no-author-1.md"),
        `---\nid: 20260901-no-author-1\nstatus: pending\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc without author`
      );

      // Doc with empty whitespace author
      fs.writeFileSync(
        path.join(pendingDir, "20260901-no-author-2.md"),
        `---\nid: 20260901-no-author-2\nauthor: '   '\nstatus: pending\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc with blank author`
      );

      const result = await runtime.run(leaderboardAction, {});
      assert.equal(result.leaderboard.length, 1);
      assert.equal(result.leaderboard[0].author, "alice");

      // Overview should include all 3 submissions
      assert.equal(result.overview.totalContributors, 1);
      assert.equal(result.overview.totalSubmissions, 3);
      assert.equal(result.overview.totalAccepted, 1);
      assert.equal(result.overview.totalPending, 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("aggregates topDomains up to 3 sorted by frequency and handles various resolution types", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-lb-domains-resolutions-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const processedDir = path.join(tmpDir, "processed", "2026");
      fs.mkdirSync(path.join(processedDir, "accepted"), { recursive: true });
      fs.mkdirSync(path.join(processedDir, "rejected"), { recursive: true });
      fs.mkdirSync(path.join(processedDir, "duplicate"), { recursive: true });
      fs.mkdirSync(path.join(processedDir, "insufficient_evidence"), { recursive: true });

      // Alice:
      // 3 docs in 'db'
      // 2 docs in 'infra'
      // 1 doc in 'api'
      // 1 doc in 'security'
      // Resolutions: 1 accepted, 1 rejected, 1 duplicate, 1 insufficient_evidence -> accepted 1, rejected 3
      fs.writeFileSync(
        path.join(processedDir, "accepted", "20260901-alice-1.md"),
        `---\nid: 20260901-alice-1\nauthor: alice\ndomain: db\nstatus: processed\nresolution: accepted\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc`
      );
      fs.writeFileSync(
        path.join(processedDir, "rejected", "20260901-alice-2.md"),
        `---\nid: 20260901-alice-2\nauthor: alice\ndomain: db\nstatus: processed\nresolution: rejected\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc`
      );
      fs.writeFileSync(
        path.join(processedDir, "duplicate", "20260901-alice-3.md"),
        `---\nid: 20260901-alice-3\nauthor: alice\ndomain: db\nstatus: processed\nresolution: duplicate\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc`
      );
      fs.writeFileSync(
        path.join(processedDir, "insufficient_evidence", "20260901-alice-4.md"),
        `---\nid: 20260901-alice-4\nauthor: alice\ndomain: infra\nstatus: processed\nresolution: insufficient_evidence\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc`
      );
      fs.writeFileSync(
        path.join(processedDir, "accepted", "20260901-alice-5.md"),
        `---\nid: 20260901-alice-5\nauthor: alice\ndomain: infra\nstatus: processed\nresolution: accepted\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc`
      );
      fs.writeFileSync(
        path.join(processedDir, "accepted", "20260901-alice-6.md"),
        `---\nid: 20260901-alice-6\nauthor: alice\ndomain: api\nstatus: processed\nresolution: accepted\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc`
      );
      fs.writeFileSync(
        path.join(processedDir, "accepted", "20260901-alice-7.md"),
        `---\nid: 20260901-alice-7\nauthor: alice\ndomain: security\nstatus: processed\nresolution: accepted\ncreated_at: '2026-09-01T00:00:00Z'\n---\n# Doc`
      );

      const result = await runtime.run(leaderboardAction, {});
      assert.equal(result.leaderboard.length, 1);
      const alice = result.leaderboard[0];
      assert.equal(alice.acceptedCount, 4);
      assert.equal(alice.rejectedCount, 3);
      assert.equal(alice.totalCount, 7);
      assert.equal(alice.acceptanceRate, 0.57); // 4 / 7 = 0.5714...

      // topDomains should have top 3: db (3), infra (2), and between api (1) and security (1), api comes first alphabetically
      assert.deepEqual(alice.topDomains, ["db", "infra", "api"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
