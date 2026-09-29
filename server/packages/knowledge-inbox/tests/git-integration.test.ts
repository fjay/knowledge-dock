import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTestRuntime } from "@actiondock/testing";
import collectAction from "../actions/knowledge-collect.ts";
import archiveAction from "../actions/knowledge-archive.ts";

const execFileAsync = promisify(execFile);

describe("knowledge-inbox git version control integration", () => {
  it("automatically commits candidate when collected in git repository", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-git-collect-"));
    try {
      // 1. Initialize temporary directory as git repository
      await execFileAsync("git", ["init"], { cwd: tmpDir });
      await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: tmpDir });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir });

      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const content = `# Nginx 504 Gateway Timeout Troubleshooting
When proxy_read_timeout is too short, long-running upstream requests will be terminated with 504.`;

      // 2. Run knowledge.collect
      const result = await runtime.run(collectAction, {
        content,
        filename: "nginx-timeout",
      });

      assert.ok(result.id);
      assert.equal(result.status, "pending");

      // 3. Verify git commit was created with expected message
      const { stdout: logMsg } = await execFileAsync("git", ["log", "-1", "--pretty=%s"], { cwd: tmpDir });
      const expectedCommit = `feat(inbox): collect candidate ${result.id} - Nginx 504 Gateway Timeout Troubleshooting`;
      assert.equal(logMsg.trim(), expectedCommit);

      // 4. Verify git status is clean (the file was staged and committed)
      const { stdout: statusOut } = await execFileAsync("git", ["status", "--porcelain"], { cwd: tmpDir });
      assert.equal(statusOut.trim(), "");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("gracefully degrades when collected in a non-git directory without errors", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-nongit-collect-"));
    try {
      // tmpDir is NOT a git repo
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const content = "# Redis Memory Leak\nInspect maxmemory-policy.";
      const result = await runtime.run(collectAction, {
        content,
        filename: "redis-leak",
      });

      assert.ok(result.id);
      assert.equal(result.status, "pending");
      assert.ok(fs.existsSync(result.path));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("automatically commits archived candidate when moved in git repository", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-git-archive-"));
    try {
      // 1. Initialize temporary directory as git repository
      await execFileAsync("git", ["init"], { cwd: tmpDir });
      await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: tmpDir });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir });

      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      // 2. First collect a candidate
      const collectRes = await runtime.run(collectAction, {
        content: "# Kafka Consumer Lag\nCheck consumer group offsets.",
        filename: "kafka-lag",
      });

      // 3. Now archive the candidate
      const archiveRes = await runtime.run(archiveAction, {
        id: collectRes.id,
        resolution: "accepted",
        note: "Verified in production incident post-mortem",
      });

      assert.equal(archiveRes.status, "archived");
      assert.equal(archiveRes.resolution, "accepted");

      // 4. Verify latest git commit message for archive
      const { stdout: logMsg } = await execFileAsync("git", ["log", "-1", "--pretty=%s"], { cwd: tmpDir });
      const expectedCommit = `chore(inbox): archive candidate ${collectRes.id} as accepted`;
      assert.equal(logMsg.trim(), expectedCommit);

      // 5. Verify git status is clean (file was moved from pending to processed and committed)
      const { stdout: statusOut } = await execFileAsync("git", ["status", "--porcelain"], { cwd: tmpDir });
      assert.equal(statusOut.trim(), "");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("gracefully degrades when archived in a non-git directory without errors", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-nongit-archive-"));
    try {
      // tmpDir is NOT a git repo
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const collectRes = await runtime.run(collectAction, {
        content: "# JVM GC Overhead\nCheck heap memory dump.",
        filename: "jvm-gc",
      });

      const archiveRes = await runtime.run(archiveAction, {
        id: collectRes.id,
        resolution: "duplicate",
      });

      assert.equal(archiveRes.status, "archived");
      assert.equal(archiveRes.resolution, "duplicate");
      assert.ok(fs.existsSync(archiveRes.toPath));
      assert.ok(!fs.existsSync(archiveRes.fromPath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
