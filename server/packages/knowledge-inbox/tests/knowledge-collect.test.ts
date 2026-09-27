import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestRuntime } from "@actiondock/testing";
import collectAction from "../actions/knowledge-collect.ts";
import listAction from "../actions/knowledge-list.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";

describe("knowledge.collect", () => {
  it("rejects empty or whitespace-only content with 400 error", async () => {
    const runtime = createTestRuntime();

    await assert.rejects(
      () => runtime.run(collectAction, { content: "" }),
      (err: any) => err.code === "CONTENT_REQUIRED"
    );

    await assert.rejects(
      () => runtime.run(collectAction, { content: "   \n\t  " }),
      (err: any) => err.code === "CONTENT_REQUIRED"
    );
  });

  it("successfully collects raw markdown without frontmatter, auto-injecting metadata and inferring heading title", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-collect-raw-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const content = `# MySQL Deadlock Investigation
When running concurrent transactions under REPEATABLE READ, lock escalations can trigger deadlock 1213.
Check SHOW ENGINE INNODB STATUS.`;

      const result = await runtime.run(collectAction, {
        content,
        filename: "mysql-deadlock",
      });

      assert.ok(result.id);
      assert.match(result.id, /^\d{8}-[0-9a-f]{6}$/);
      assert.equal(result.status, "pending");
      assert.match(result.filename, /^\d{8}-\d{6}-[0-9a-f]{6}-mysql-deadlock\.md$/);
      assert.equal(result.path, path.join(tmpDir, "pending", result.filename));

      // Verify file exists on disk
      assert.ok(fs.existsSync(result.path));
      const fileText = fs.readFileSync(result.path, "utf-8");

      // Verify enriched frontmatter
      const parsed = parseFrontmatter(fileText);
      assert.equal(parsed.hasFrontmatter, true);
      assert.equal(parsed.data.id, result.id);
      assert.equal(parsed.data.status, "pending");
      assert.equal(parsed.data.title, "MySQL Deadlock Investigation");
      assert.ok(parsed.data.created_at);
      assert.match(parsed.body, /# MySQL Deadlock Investigation/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves existing frontmatter fields while appending/overriding server metadata", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-collect-fm-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const content = `---
title: Custom Frontmatter Document
domain: storage
tags:
  - ceph
  - s3
customField: preserved
status: old_status
id: fake_old_id
---

## Incident Summary
Object storage latency spiked due to disk scrub operations.`;

      const result = await runtime.run(collectAction, {
        content,
      });

      assert.equal(result.status, "pending");
      assert.match(result.filename, /^\d{8}-\d{6}-[0-9a-f]{6}-Custom-Frontmatter-Document\.md$/);

      const fileText = fs.readFileSync(result.path, "utf-8");
      const parsed = parseFrontmatter(fileText);

      assert.equal(parsed.data.title, "Custom Frontmatter Document");
      assert.equal(parsed.data.domain, "storage");
      assert.deepEqual(parsed.data.tags, ["ceph", "s3"]);
      assert.equal(parsed.data.customField, "preserved");
      assert.equal(parsed.data.status, "pending"); // Overwritten by server
      assert.equal(parsed.data.id, result.id); // Overwritten by server
      assert.ok(parsed.data.created_at);
      assert.match(parsed.body, /## Incident Summary/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("sanitizes suggested filenames and strictly prevents directory traversal", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-collect-traversal-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const content = "Direct troubleshooting content without headers.";
      const result = await runtime.run(collectAction, {
        content,
        filename: "../../../etc/passwd.md",
      });

      assert.ok(result.filename.endsWith("-passwd.md"));
      assert.equal(path.dirname(result.path), path.join(tmpDir, "pending"));
      assert.ok(fs.existsSync(result.path));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back to 'candidate' when no filename, heading, or title is provided", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-collect-fallback-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const content = "No title, no headings, just bare notes.";
      const result = await runtime.run(collectAction, {
        content,
      });

      assert.match(result.filename, /^\d{8}-\d{6}-[0-9a-f]{6}-candidate\.md$/);
      assert.ok(fs.existsSync(result.path));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("successfully collects candidate with repos in frontmatter, persisting repos to disk frontmatter", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-collect-fm-repos-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const content = `---
title: Order Payment Timeout
repos:
  - order-service
---
# Order Payment Timeout
When order-service fails to reach payment-service, check RPC timeout settings.`;

      const result = await runtime.run(collectAction, {
        content,
        filename: "order-payment-timeout",
      });

      assert.equal(result.status, "pending");
      assert.ok(result.id);
      assert.ok(result.filename);
      assert.ok(result.path);

      const fileText = fs.readFileSync(result.path, "utf-8");
      const parsed = parseFrontmatter(fileText);

      assert.deepEqual(parsed.data.repos, ["order-service"]);
      assert.equal(parsed.data.repo, undefined);
      assert.equal(parsed.data.title, "Order Payment Timeout");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("successfully collects candidate with multi-repo array in frontmatter", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-collect-multi-repos-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const content = `---
title: Distributed Transaction Compensation
repos:
  - order-service
  - payment-service
---
# Distributed Transaction Compensation
Saga pattern failure between order-service and payment-service.`;

      const result = await runtime.run(collectAction, {
        content,
        filename: "saga-compensation",
      });

      assert.equal(result.status, "pending");

      const fileText = fs.readFileSync(result.path, "utf-8");
      const parsed = parseFrontmatter(fileText);

      assert.deepEqual(parsed.data.repos, ["order-service", "payment-service"]);
      assert.equal(parsed.data.repo, undefined);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("extracts and normalizes legacy repo frontmatter field into repos array", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-collect-legacy-repo-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const content = `---
title: System Knowledge SOP
repo: system-knowledge
---
# System Knowledge SOP
Standard maintenance procedures.`;

      const result = await runtime.run(collectAction, { content });

      assert.equal(result.status, "pending");

      const fileText = fs.readFileSync(result.path, "utf-8");
      const parsed = parseFrontmatter(fileText);
      assert.deepEqual(parsed.data.repos, ["system-knowledge"]);
      assert.equal(parsed.data.repo, undefined);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("normalizes comma-separated legacy repo string from frontmatter into repos array", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-collect-comma-repo-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const content = `---
title: Cross Service Latency
repo: "order-service, payment-service"
---
Cross-service latency troubleshooting notes.`;

      const result = await runtime.run(collectAction, { content });

      assert.equal(result.status, "pending");

      const fileText = fs.readFileSync(result.path, "utf-8");
      const parsed = parseFrontmatter(fileText);
      assert.deepEqual(parsed.data.repos, ["order-service", "payment-service"]);
      assert.equal(parsed.data.repo, undefined);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("maintains complete backward compatibility when repo/repos are omitted", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-collect-compat-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const content = `# Standalone Note
No repository associated.`;

      const result = await runtime.run(collectAction, { content });

      assert.equal(result.status, "pending");

      const fileText = fs.readFileSync(result.path, "utf-8");
      const parsed = parseFrontmatter(fileText);
      assert.equal(parsed.data.repo, undefined);
      assert.equal(parsed.data.repos, undefined);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("collects document with frontmatter repos, verifies disk frontmatter, and allows knowledge.list to extract and filter by repo", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-collect-list-integration-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const content = `---
title: Order Payment Timeout Solution
repos:
  - order-service
---
# Order Payment Timeout Solution
Fix RPC client connection pooling.`;

      const collectResult = await runtime.run(collectAction, {
        content,
        filename: "order-timeout-fix",
      });

      assert.equal(collectResult.status, "pending");
      assert.ok(collectResult.id);
      assert.equal((collectResult as any).repos, undefined);
      assert.equal((collectResult as any).repo, undefined);

      // Verify file on disk has repos array in frontmatter and no repo field
      const diskContent = fs.readFileSync(collectResult.path, "utf-8");
      const parsed = parseFrontmatter(diskContent);
      assert.deepEqual(parsed.data.repos, ["order-service"]);
      assert.equal(parsed.data.repo, undefined);

      // Verify knowledge.list extracts repos and filters by repo
      const listMatch = await runtime.run(listAction, { repo: "order-service" });
      assert.equal(listMatch.items.length, 1);
      assert.equal(listMatch.items[0].id, collectResult.id);
      assert.deepEqual(listMatch.items[0].repos, ["order-service"]);
      assert.equal((listMatch.items[0] as any).repo, undefined);

      // Filter by unrelated repo returns empty
      const listMismatch = await runtime.run(listAction, { repo: "other-service" });
      assert.equal(listMismatch.items.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
