import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestRuntime } from "@actiondock/testing";
import archiveAction from "../actions/knowledge-archive.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";

describe("knowledge.archive", () => {
  it("rejects empty id with 400 error", async () => {
    const runtime = createTestRuntime();

    await assert.rejects(
      () => runtime.run(archiveAction, { id: "" }),
      (err: any) => err.code === "ID_REQUIRED"
    );

    await assert.rejects(
      () => runtime.run(archiveAction, { id: "   " }),
      (err: any) => err.code === "ID_REQUIRED"
    );
  });

  it("rejects invalid resolution with 400 error", async () => {
    const runtime = createTestRuntime();

    await assert.rejects(
      () =>
        runtime.run(archiveAction, {
          id: "20260924-a1b2c3",
          resolution: "invalid_resolution" as any,
        }),
      (err: any) => err.code === "INVALID_RESOLUTION"
    );
  });

  it("throws 404 error when candidate document does not exist in pending", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-arch-404-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      await assert.rejects(
        () => runtime.run(archiveAction, { id: "non-existent-id" }),
        (err: any) => err.code === "DOCUMENT_NOT_FOUND"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("successfully archives candidate by ID, updating frontmatter and atomically moving to processed directory", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-arch-succ-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const pendingDir = path.join(tmpDir, "pending");
      fs.mkdirSync(pendingDir, { recursive: true });

      const currentYear = new Date().getUTCFullYear().toString();
      const filename = `${currentYear}0924-112345-a1b2c3-redis-failover.md`;
      const pendingFilePath = path.join(pendingDir, filename);

      const initialContent = `---
title: Redis Failover Procedure
domain: cache
tags:
  - redis
  - sentinel
id: ${currentYear}0924-a1b2c3
created_at: '${currentYear}-09-24T11:23:45.000Z'
status: pending
---

# Redis Failover Procedure
Execute sentinel failover mymaster.`;

      fs.writeFileSync(pendingFilePath, initialContent, "utf-8");

      // Archive by ID
      const result = await runtime.run(archiveAction, {
        id: `${currentYear}0924-a1b2c3`,
        resolution: "accepted",
        note: "Reviewed and verified on staging cluster.",
      });

      assert.equal(result.id, `${currentYear}0924-a1b2c3`);
      assert.equal(result.fromPath, pendingFilePath);
      assert.equal(result.resolution, "accepted");
      assert.equal(result.status, "archived");
      assert.equal(result.year, currentYear);

      const expectedTargetPath = path.join(
        tmpDir,
        "processed",
        currentYear,
        "accepted",
        filename
      );
      assert.equal(result.toPath, expectedTargetPath);

      // Verify file moved
      assert.equal(fs.existsSync(pendingFilePath), false);
      assert.equal(fs.existsSync(expectedTargetPath), true);

      // Verify frontmatter update
      const updatedText = fs.readFileSync(expectedTargetPath, "utf-8");
      const parsed = parseFrontmatter(updatedText);

      assert.equal(parsed.data.id, `${currentYear}0924-a1b2c3`);
      assert.equal(parsed.data.title, "Redis Failover Procedure");
      assert.equal(parsed.data.domain, "cache");
      assert.deepEqual(parsed.data.tags, ["redis", "sentinel"]);
      assert.equal(parsed.data.status, "processed");
      assert.equal(parsed.data.resolution, "accepted");
      assert.ok(parsed.data.archived_at);
      assert.equal(parsed.data.archive_note, "Reviewed and verified on staging cluster.");
      assert.match(parsed.body, /Execute sentinel failover mymaster/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("successfully archives candidate matching by full filename and defaults resolution to 'accepted'", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-arch-filename-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const pendingDir = path.join(tmpDir, "pending");
      fs.mkdirSync(pendingDir, { recursive: true });

      const currentYear = new Date().getUTCFullYear().toString();
      const filename = `${currentYear}0924-113000-c4d5e6-dns-nxdomain.md`;
      const pendingFilePath = path.join(pendingDir, filename);

      fs.writeFileSync(
        pendingFilePath,
        `---
title: DNS NXDOMAIN Troubleshooting
id: ${currentYear}0924-c4d5e6
created_at: '${currentYear}-09-24T11:30:00.000Z'
status: pending
---

Check coredns configmap.`,
        "utf-8"
      );

      // Archive by filename with no resolution specified (defaults to accepted)
      const result = await runtime.run(archiveAction, {
        id: filename,
      });

      assert.equal(result.id, `${currentYear}0924-c4d5e6`);
      assert.equal(result.resolution, "accepted");
      assert.equal(result.status, "archived");
      assert.equal(result.year, currentYear);

      const expectedTargetPath = path.join(
        tmpDir,
        "processed",
        currentYear,
        "accepted",
        filename
      );
      assert.equal(result.toPath, expectedTargetPath);
      assert.equal(fs.existsSync(pendingFilePath), false);
      assert.equal(fs.existsSync(expectedTargetPath), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("supports resolutions 'duplicate', 'rejected', and 'insufficient_evidence'", async () => {
    const resolutions = ["duplicate", "rejected", "insufficient_evidence"] as const;
    const currentYear = new Date().getUTCFullYear().toString();

    for (const res of resolutions) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `kb-arch-${res}-`));
      try {
        const runtime = createTestRuntime();
        runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

        const pendingDir = path.join(tmpDir, "pending");
        fs.mkdirSync(pendingDir, { recursive: true });

        const filename = `${currentYear}0924-120000-xxx111-${res}.md`;
        const pendingFilePath = path.join(pendingDir, filename);

        fs.writeFileSync(
          pendingFilePath,
          `---
id: ${currentYear}0924-xxx111
status: pending
---
Notes for ${res}`,
          "utf-8"
        );

        const result = await runtime.run(archiveAction, {
          id: `${currentYear}0924-xxx111`,
          resolution: res,
          note: `Archived as ${res}`,
        });

        assert.equal(result.resolution, res);
        assert.equal(result.status, "archived");
        assert.equal(result.year, currentYear);

        const targetPath = path.join(tmpDir, "processed", currentYear, res, filename);
        assert.equal(fs.existsSync(targetPath), true);

        const updated = parseFrontmatter(fs.readFileSync(targetPath, "utf-8"));
        assert.equal(updated.data.resolution, res);
        assert.equal(updated.data.status, "processed");
        assert.equal(updated.data.archive_note, `Archived as ${res}`);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  it("extracts year from candidate createdAt first, then id prefix, and falls back to current year", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-arch-year-extract-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const pendingDir = path.join(tmpDir, "pending");
      fs.mkdirSync(pendingDir, { recursive: true });

      // Case 1: Candidate with createdAt from 2024
      const file1 = path.join(pendingDir, "doc-from-2024.md");
      fs.writeFileSync(
        file1,
        `---
id: 20260924-idoverride
created_at: '2024-03-15T10:00:00.000Z'
status: pending
---
Body 1`
      );

      const res1 = await runtime.run(archiveAction, { id: "doc-from-2024.md" });
      assert.equal(res1.year, "2024");
      assert.equal(
        res1.toPath,
        path.join(tmpDir, "processed", "2024", "accepted", "doc-from-2024.md")
      );
      assert.equal(fs.existsSync(res1.toPath), true);

      // Case 2: Candidate without createdAt, id prefix 2025
      const file2 = path.join(pendingDir, "20250810-fix.md");
      fs.writeFileSync(
        file2,
        `---
id: 20250810-abc
status: pending
---
Body 2`
      );

      const res2 = await runtime.run(archiveAction, { id: "20250810-abc" });
      assert.equal(res2.year, "2025");
      assert.equal(
        res2.toPath,
        path.join(tmpDir, "processed", "2025", "accepted", "20250810-fix.md")
      );
      assert.equal(fs.existsSync(res2.toPath), true);

      // Case 3: Candidate without createdAt and arbitrary id -> fallback to current year
      const currentYear = new Date().getUTCFullYear().toString();
      const file3 = path.join(pendingDir, "arbitrary-name.md");
      fs.writeFileSync(
        file3,
        `---
id: arbitrary-candidate
status: pending
---
Body 3`
      );

      const res3 = await runtime.run(archiveAction, { id: "arbitrary-candidate" });
      assert.equal(res3.year, currentYear);
      assert.equal(
        res3.toPath,
        path.join(tmpDir, "processed", currentYear, "accepted", "arbitrary-name.md")
      );
      assert.equal(fs.existsSync(res3.toPath), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
