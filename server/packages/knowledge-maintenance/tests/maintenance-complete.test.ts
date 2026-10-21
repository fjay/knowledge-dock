import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestRuntime, createTestPlatform, FakeProcessDriver } from "@actiondock/testing";
import { encodeStateKey } from "@actiondock/sdk";
import completeAction from "../actions/maintenance-complete.ts";

describe("maintenance.complete", () => {
  it("rejects invalid commit hash formats", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "complete-format-"));
    try {
      const runtime = createTestRuntime();

      // Too short (< 7 chars)
      await assert.rejects(
        () => runtime.run(completeAction, { path: tmpDir, commit: "abc12" }),
        (err: any) => err.code === "INVALID_COMMIT_HASH"
      );

      // Non-hex characters
      await assert.rejects(
        () => runtime.run(completeAction, { path: tmpDir, commit: "xyz12345" }),
        (err: any) => err.code === "INVALID_COMMIT_HASH"
      );

      // Empty commit
      await assert.rejects(
        () => runtime.run(completeAction, { path: tmpDir, commit: "" }),
        (err: any) => err.code === "INVALID_COMMIT_HASH"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects commit when commit does not exist in repository", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "complete-notfound-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd.startsWith("cat-file -e")) {
          handle.emitOutput("stderr", "fatal: Not a valid object name\n");
          handle.emitExit({ code: 128, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      await assert.rejects(
        () => runtime.run(completeAction, { path: tmpDir, commit: "1234567" }),
        (err: any) => err.code === "COMMIT_NOT_FOUND"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed knowledge changes before git execution without modifying checkpoint", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "complete-invalid-metadata-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });
      const stateKey = encodeStateKey("checkpoints", "demo-repo");
      const previous = { commit: "1234567", summary: "上次结果", knowledgeChanges: [] };
      await runtime.state.set(stateKey, previous);
      const invalidPaths = [
        "", "   ", "/etc/passwd", "//server/share/doc.md", "../secret.md",
        "docs/../../secret.md", "docs/../secret.md", "docs/./doc.md", "docs//doc.md",
        "C:/secret.md", "C:secret.md", "C:\\secret.md", "docs\\doc.md",
        "docs/file\u0000.md", "docs/file\n.md", "docs/file\t.md", "docs/file\u007f.md",
        "docs/file\u0085.md", "docs/.. /secret.md", "docs/", " docs/file.md",
      ];
      const invalidValues: unknown[] = [
        null, {}, "docs/file.md", [null], ["docs/file.md"], [[]], [{}],
        [{ path: 42, summary: "主题" }],
        [{ path: "docs/file.md" }],
        [{ path: "docs/file.md", summary: null }],
        [{ path: "docs/file.md", summary: 42 }],
        [{ path: "docs/file.md", summary: "" }],
        [{ path: "docs/file.md", summary: " \n\t " }],
        [{ path: "docs/file.md", summary: "主题", extra: true }],
        ...invalidPaths.map((documentPath) => [{ path: documentPath, summary: "主题" }]),
      ];
      for (const knowledgeChanges of invalidValues) {
        await assert.rejects(
          () => runtime.run(completeAction, {
            path: tmpDir,
            commit: "1234567",
            knowledgeChanges,
          } as any),
          (err: any) => err.code === "INVALID_KNOWLEDGE_CHANGES" &&
            /Invalid knowledgeChanges/.test(err.message),
          JSON.stringify(knowledgeChanges)
        );
        assert.deepEqual(await runtime.state.get(stateKey), previous);
      }
      assert.equal(fakeDriver.spawnCalls.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("successfully updates checkpoint in ctx.state and tracks previous commit", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "complete-succ-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const shortCommit1 = "1234567";
      const fullCommit1 = "1234567890abcdef1234567890abcdef12345678";
      const shortCommit2 = "abcdef0";
      const fullCommit2 = "abcdef0123456789abcdef0123456789abcdef01";

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd.includes("cat-file -e")) {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === `rev-parse ${shortCommit1}^{commit}`) {
          handle.emitOutput("stdout", `${fullCommit1}\n`);
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === `rev-parse ${shortCommit2}^{commit}`) {
          handle.emitOutput("stdout", `${fullCommit2}\n`);
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "config --get remote.origin.url") {
          handle.emitOutput("stdout", "https://github.com/myorg/payment-service.git\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const knowledgeChanges = [
        { path: "docs/knowledge/支付回调.md", summary: "新增支付回调与重试主题" },
        { path: "docs/knowledge/architecture.md", summary: "修改支付模块职责" },
        { path: "docs/knowledge/removed.md", summary: "删除过期接口说明" },
      ];

      // 1. First completion (no prior checkpoint)
      const res1 = await runtime.run(completeAction, {
        path: tmpDir,
        commit: shortCommit1,
        actionTaken: "docs_updated",
        summary: "Updated payment callback diagram",
        knowledgeChanges,
      });

      assert.equal(res1.repo, "payment-service");
      assert.equal(res1.previousCommit, null);
      assert.equal(res1.currentCommit, fullCommit1);
      assert.equal(res1.actionTaken, "docs_updated");
      assert.equal(res1.summary, "Updated payment callback diagram");
      assert.deepEqual(res1.knowledgeChanges, knowledgeChanges);
      assert.ok(res1.updatedAt);

      // Verify stored in state
      const stateKey = encodeStateKey("checkpoints", "payment-service");
      const saved1 = await runtime.state.get<any>(stateKey);
      assert.equal(saved1?.commit, fullCommit1);
      assert.equal(saved1?.actionTaken, "docs_updated");
      assert.equal(saved1?.summary, res1.summary);
      assert.deepEqual(saved1?.knowledgeChanges, knowledgeChanges);

      // 2. Second completion (should record previousCommit = fullCommit1)
      const res2 = await runtime.run(completeAction, {
        path: tmpDir,
        commit: shortCommit2,
        actionTaken: "no_change_needed",
        summary: "Verified no knowledge impact",
      });

      assert.equal(res2.repo, "payment-service");
      assert.equal(res2.previousCommit, fullCommit1);
      assert.equal(res2.currentCommit, fullCommit2);
      assert.equal(res2.actionTaken, "no_change_needed");
      assert.equal(res2.summary, "Verified no knowledge impact");

      const saved2 = await runtime.state.get<any>(stateKey);
      assert.equal(saved2?.commit, fullCommit2);
      assert.equal(saved2?.actionTaken, "no_change_needed");
      assert.equal(saved2?.summary, res2.summary);
      assert.equal(Object.hasOwn(res2, "knowledgeChanges"), false);
      assert.equal(Object.hasOwn(saved2, "knowledgeChanges"), false);

      // 显式空数组表示已核验无文档改动，并替换旧清单。
      await runtime.state.set(stateKey, saved1);
      const res3 = await runtime.run(completeAction, {
        path: tmpDir,
        commit: shortCommit2,
        summary: "已核验没有文档改动",
        knowledgeChanges: [],
      });
      assert.deepEqual(res3.knowledgeChanges, []);
      const saved3 = await runtime.state.get<any>(stateKey);
      assert.deepEqual(saved3?.knowledgeChanges, []);
      assert.equal(saved3?.summary, "已核验没有文档改动");

      // 旧参数也不能继承上次的空数组核验结果。
      const res4 = await runtime.run(completeAction, { path: tmpDir, commit: shortCommit2 });
      const saved4 = await runtime.state.get<any>(stateKey);
      assert.equal(Object.hasOwn(res4, "knowledgeChanges"), false);
      assert.equal(Object.hasOwn(saved4, "knowledgeChanges"), false);
      assert.equal(saved4?.summary, "");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
