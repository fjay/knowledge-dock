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

      // 1. First completion (no prior checkpoint)
      const res1 = await runtime.run(completeAction, {
        path: tmpDir,
        commit: shortCommit1,
        actionTaken: "docs_updated",
        summary: "Updated payment callback diagram",
      });

      assert.equal(res1.repo, "payment-service");
      assert.equal(res1.previousCommit, null);
      assert.equal(res1.currentCommit, fullCommit1);
      assert.equal(res1.actionTaken, "docs_updated");
      assert.equal(res1.summary, "Updated payment callback diagram");
      assert.ok(res1.updatedAt);

      // Verify stored in state
      const stateKey = encodeStateKey("checkpoints", "payment-service");
      const saved1 = await runtime.state.get<any>(stateKey);
      assert.equal(saved1?.commit, fullCommit1);
      assert.equal(saved1?.actionTaken, "docs_updated");

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
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
