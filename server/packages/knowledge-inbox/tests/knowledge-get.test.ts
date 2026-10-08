import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestRuntime } from "@actiondock/testing";
import getAction from "../actions/knowledge-get.ts";

describe("knowledge.get", () => {
  it("rejects empty identifier with 400 error", async () => {
    const runtime = createTestRuntime();

    await assert.rejects(
      () => runtime.run(getAction, { id: "" }),
      (err: any) => err.code === "IDENTIFIER_REQUIRED"
    );

    await assert.rejects(
      () => runtime.run(getAction, {} as any),
      (err: any) => err.code === "IDENTIFIER_REQUIRED"
    );
  });

  it("rejects invalid status with 400 error", async () => {
    const runtime = createTestRuntime();

    await assert.rejects(
      () => runtime.run(getAction, { id: "20260924-a1b2c3", status: "unknown" as any }),
      (err: any) => err.code === "INVALID_STATUS"
    );
  });

  it("rejects path traversal outside inbox root with 403 error", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-get-traversal-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      await assert.rejects(
        () => runtime.run(getAction, { path: "../../etc/passwd" }),
        (err: any) => err.code === "PATH_OUTSIDE_INBOX"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws 404 error when candidate document does not exist", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-get-404-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      await assert.rejects(
        () => runtime.run(getAction, { id: "non-existent-id" }),
        (err: any) => err.code === "DOCUMENT_NOT_FOUND"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("successfully gets pending candidate by ID, returning complete markdown content, body, and all metadata", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-get-succ-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const pendingDir = path.join(tmpDir, "pending");
      fs.mkdirSync(pendingDir, { recursive: true });

      const rawMarkdown = `---
id: 20260924-a1b2c3
title: Redis Split Brain Recovery
domain: infrastructure
repos:
  - order-service
  - payment-service
tags:
  - redis
  - cluster
author: jay.wu
created_at: 2026-09-24T11:23:45.000Z
status: pending
---

# Redis Split Brain Recovery

When cluster partitions occur, check min-replicas-to-write setting.
`;

      const filename = "20260924-112345-a1b2c3-redis-split-brain.md";
      const filePath = path.join(pendingDir, filename);
      fs.writeFileSync(filePath, rawMarkdown, "utf-8");

      const result = await runtime.run(getAction, { id: "20260924-a1b2c3" });

      assert.equal(result.id, "20260924-a1b2c3");
      assert.equal(result.filename, filename);
      assert.equal(result.path, filePath);
      assert.equal(result.status, "pending");
      assert.equal(result.title, "Redis Split Brain Recovery");
      assert.equal(result.domain, "infrastructure");
      assert.deepEqual(result.tags, ["redis", "cluster"]);
      assert.deepEqual(result.repos, ["order-service", "payment-service"]);
      assert.equal(result.author, "jay.wu");
      assert.equal(result.createdAt, "2026-09-24T11:23:45.000Z");
      assert.equal(result.content, rawMarkdown);
      assert.ok(result.body.includes("# Redis Split Brain Recovery"));
      assert.ok(result.body.includes("When cluster partitions occur"));
      assert.ok(!result.body.startsWith("---"));
      assert.equal(result.frontmatter?.domain, "infrastructure");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("successfully gets candidate by filename and by direct path", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-get-path-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const pendingDir = path.join(tmpDir, "pending");
      fs.mkdirSync(pendingDir, { recursive: true });

      const rawMarkdown = `# MySQL Timeout

When encountering error 2006, adjust wait_timeout.
`;
      const filename = "20260924-112345-d4e5f6-mysql-timeout.md";
      const filePath = path.join(pendingDir, filename);
      fs.writeFileSync(filePath, rawMarkdown, "utf-8");

      // By filename as id
      const byFilename = await runtime.run(getAction, { id: filename });
      assert.equal(byFilename.id, "20260924-d4e5f6");
      assert.equal(byFilename.content, rawMarkdown);

      // By relative path
      const byRelPath = await runtime.run(getAction, { path: `pending/${filename}` });
      assert.equal(byRelPath.id, "20260924-d4e5f6");
      assert.equal(byRelPath.content, rawMarkdown);

      // By absolute path
      const byAbsPath = await runtime.run(getAction, { path: filePath });
      assert.equal(byAbsPath.id, "20260924-d4e5f6");
      assert.equal(byAbsPath.content, rawMarkdown);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("successfully gets archived candidate across processed directories", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-get-arch-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const processedDir = path.join(tmpDir, "processed", "2026", "accepted");
      fs.mkdirSync(processedDir, { recursive: true });

      const rawMarkdown = `---
id: 20260924-789abc
title: K8s Pod Eviction
resolution: accepted
archive_note: Merged into runbook
created_at: 2026-09-24T11:25:00.000Z
archived_at: 2026-09-24T12:00:00.000Z
status: processed
---

## Symptoms
Pod eviction due to ephemeral storage pressure.
`;
      const filename = "20260924-112500-789abc-k8s-pod-eviction.md";
      const filePath = path.join(processedDir, filename);
      fs.writeFileSync(filePath, rawMarkdown, "utf-8");

      const result = await runtime.run(getAction, { id: "20260924-789abc" });
      assert.equal(result.id, "20260924-789abc");
      assert.equal(result.status, "processed");
      assert.equal(result.resolution, "accepted");
      assert.equal(result.archiveNote, "Merged into runbook");
      assert.equal(result.year, "2026");
      assert.equal(result.content, rawMarkdown);

      // Filter status pending should not find processed document
      await assert.rejects(
        () => runtime.run(getAction, { id: "20260924-789abc", status: "pending" }),
        (err: any) => err.code === "DOCUMENT_NOT_FOUND"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
