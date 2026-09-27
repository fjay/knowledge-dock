import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestRuntime, createTestPlatform, FakeProcessDriver } from "@actiondock/testing";
import syncAction from "../actions/maintenance-sync.ts";

describe("maintenance.sync", () => {
  it("synchronizes dual-branch code repository successfully when remote docs branch exists", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-code-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const executedCommands: string[] = [];

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        executedCommands.push(cmd);

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", "");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "fetch --filter=blob:none origin" || cmd === "fetch origin") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify origin/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify refs/heads/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "checkout docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "merge --ff-only origin/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "merge --no-edit origin/release") {
          handle.emitOutput("stdout", "Merge made by the 'ort' strategy.\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "push origin docs") {
          handle.emitOutput("stdout", "To origin\n   abc..def  docs -> docs\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse HEAD") {
          handle.emitOutput("stdout", "9999888877776666555544443333222211110000\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(syncAction, {
        path: tmpDir,
        repoType: "code",
        sourceBranch: "release",
        knowledgeBranch: "docs",
      });

      assert.equal(res.status, "success");
      assert.equal(res.repoType, "code");
      assert.equal(res.sourceBranch, "release");
      assert.equal(res.knowledgeBranch, "docs");
      assert.equal(res.currentCommit, "9999888877776666555544443333222211110000");
      assert.equal(res.initializedBranch, false);

      assert.ok(executedCommands.some((c) => c.startsWith("fetch")));
      assert.ok(executedCommands.includes("checkout docs"));
      assert.ok(executedCommands.includes("merge --no-edit origin/release"));
      assert.ok(executedCommands.includes("push origin docs"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects dirty working tree and returns dirty_worktree without fetching or merging", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-dirty-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const executedCommands: string[] = [];

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        executedCommands.push(cmd);

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", " M src/index.ts\n?? uncommitted.txt\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(syncAction, {
        path: tmpDir,
        repoType: "code",
      });

      assert.equal(res.status, "dirty_worktree");
      assert.deepEqual(res.uncommittedFiles, ["M src/index.ts", "?? uncommitted.txt"]);
      assert.ok(res.message.includes("Working tree is dirty"));
      assert.ok(!executedCommands.includes("fetch origin"), "Should not fetch when worktree is dirty");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("safely aborts merge and returns conflict status on merge conflict", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-conflict-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const executedCommands: string[] = [];

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        executedCommands.push(cmd);

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          // If porcelain status is checked during merge, report unmerged conflict
          if (executedCommands.includes("merge --no-edit origin/release")) {
            handle.emitOutput("stdout", "UU docs/knowledge/flow.md\nUU docs/api.md\n");
          } else {
            handle.emitOutput("stdout", "");
          }
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "fetch --filter=blob:none origin" || cmd === "fetch origin") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify origin/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify refs/heads/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "checkout docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "merge --ff-only origin/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "merge --no-edit origin/release") {
          handle.emitOutput("stderr", "CONFLICT (content): Merge conflict in docs/knowledge/flow.md\nAutomatic merge failed\n");
          handle.emitExit({ code: 1, signal: null });
        } else if (cmd === "merge --abort") {
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(syncAction, {
        path: tmpDir,
        repoType: "code",
      });

      assert.equal(res.status, "conflict");
      assert.deepEqual(res.conflictFiles, ["docs/knowledge/flow.md", "docs/api.md"]);
      assert.ok(res.message.includes("safely aborted"));

      // Verify strict contract: git merge --abort MUST have been called, and NEVER git push
      assert.ok(executedCommands.includes("merge --abort"), "Must execute git merge --abort");
      assert.ok(!executedCommands.some((c) => c.startsWith("push")), "Must not push on conflict");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("initializes docs branch when remote origin/docs does not exist", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-init-branch-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const executedCommands: string[] = [];

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        executedCommands.push(cmd);

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", "");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "fetch --filter=blob:none origin" || cmd === "fetch origin") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify origin/docs") {
          // Remote docs does NOT exist
          handle.emitExit({ code: 1, signal: null });
        } else if (cmd === "rev-parse --verify refs/heads/docs") {
          // Local docs does not exist yet
          handle.emitExit({ code: 1, signal: null });
        } else if (cmd === "checkout -b docs origin/release") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "push origin docs") {
          handle.emitOutput("stdout", "Total 0 (delta 0), reused 0 (delta 0)\nTo origin\n * [new branch] docs -> docs\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse HEAD") {
          handle.emitOutput("stdout", "aabbccddeeff00112233445566778899aabbccdd\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(syncAction, {
        path: tmpDir,
        repoType: "code",
      });

      assert.equal(res.status, "success");
      assert.equal(res.initializedBranch, true);
      assert.equal(res.currentCommit, "aabbccddeeff00112233445566778899aabbccdd");
      assert.ok(executedCommands.includes("checkout -b docs origin/release"));
      assert.ok(executedCommands.includes("push origin docs"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("synchronizes system_knowledge single-branch repository via ff-only merge", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-sys-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const executedCommands: string[] = [];

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        executedCommands.push(cmd);

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", "");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "fetch --filter=blob:none origin" || cmd === "fetch origin") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify refs/heads/master") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "checkout master") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "merge --ff-only origin/master") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse HEAD") {
          handle.emitOutput("stdout", "3333444455556666777788889999000011112222\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(syncAction, {
        path: tmpDir,
        repoType: "system_knowledge",
        sourceBranch: "master",
      });

      assert.equal(res.status, "success");
      assert.equal(res.repoType, "system_knowledge");
      assert.equal(res.sourceBranch, "master");
      assert.equal(res.currentCommit, "3333444455556666777788889999000011112222");
      assert.ok(executedCommands.includes("merge --ff-only origin/master"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns error status if path is not a git repository", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-notgit-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stderr", "fatal: not a git repository\n");
          handle.emitExit({ code: 128, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(syncAction, {
        path: tmpDir,
      });

      assert.equal(res.status, "error");
      assert.ok(res.message.includes("not a valid git repository"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back to standard fetch when remote origin does not support --filter=blob:none", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-fallback-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const executedCommands: string[] = [];

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        executedCommands.push(cmd);

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", "");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "fetch --filter=blob:none origin") {
          // Server rejects filter option
          handle.emitOutput("stderr", "fatal: Server does not support --filter\n");
          handle.emitExit({ code: 128, signal: null });
        } else if (cmd === "fetch origin") {
          // Fallback succeeds
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify origin/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify refs/heads/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "checkout docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "merge --ff-only origin/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "merge --no-edit origin/release") {
          handle.emitOutput("stdout", "Merge made by the 'ort' strategy.\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "push origin docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse HEAD") {
          handle.emitOutput("stdout", "1111222233334444555566667777888899990000\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(syncAction, {
        path: tmpDir,
        repoType: "code",
      });

      assert.equal(res.status, "success");
      assert.equal(res.batch, undefined, "Single-repo mode should not set batch flag");
      assert.ok(executedCommands.includes("fetch --filter=blob:none origin"));
      assert.ok(executedCommands.includes("fetch origin"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("batch synchronizes multiple repositories from config file successfully", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "sync-batch-ok-"));
    const repoA = path.join(tmpBase, "repo-a");
    const repoB = path.join(tmpBase, "repo-b");
    const configFile = path.join(tmpBase, "repos.json");

    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });
    fs.writeFileSync(
      configFile,
      JSON.stringify([
        {
          path: repoA,
          repoType: "code",
          sourceBranch: "release",
          knowledgeBranch: "docs",
        },
        {
          path: repoB,
          repoType: "system_knowledge",
          sourceBranch: "master",
        },
      ])
    );

    try {
      const fakeDriver = new FakeProcessDriver();

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        const cwd = spec.cwd;

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", "");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "fetch --filter=blob:none origin" || cmd === "fetch origin") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cwd === repoA) {
          if (cmd === "rev-parse --verify origin/docs") {
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "rev-parse --verify refs/heads/docs") {
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "checkout docs") {
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "merge --ff-only origin/docs") {
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "merge --no-edit origin/release") {
            handle.emitOutput("stdout", "Merge made by the 'ort' strategy.\n");
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "push origin docs") {
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "rev-parse HEAD") {
            handle.emitOutput("stdout", "aaaa111122223333444455556666777788889999\n");
            handle.emitExit({ code: 0, signal: null });
          } else {
            handle.emitExit({ code: 0, signal: null });
          }
        } else if (cwd === repoB) {
          if (cmd === "rev-parse --verify refs/heads/master") {
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "checkout master") {
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "merge --ff-only origin/master") {
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "rev-parse HEAD") {
            handle.emitOutput("stdout", "bbbb111122223333444455556666777788889999\n");
            handle.emitExit({ code: 0, signal: null });
          } else {
            handle.emitExit({ code: 0, signal: null });
          }
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(syncAction, {
        config: configFile,
      });

      assert.equal(res.batch, true);
      assert.equal(res.status, "success");
      assert.equal(res.summary?.total, 2);
      assert.equal(res.summary?.syncedCount, 2);
      assert.equal(res.summary?.conflictCount, 0);
      assert.equal(res.summary?.errorCount, 0);
      assert.equal(res.results?.length, 2);
      assert.equal(res.results?.[0]?.status, "success");
      assert.equal(res.results?.[0]?.path, repoA);
      assert.equal(res.results?.[1]?.status, "success");
      assert.equal(res.results?.[1]?.path, repoB);
      assert.deepEqual(res.conflicts, []);
      assert.ok(res.message.includes("Successfully synchronized all 2 repositories"));
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("batch synchronizes with merge conflict and records conflict status and files", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "sync-batch-conflict-"));
    const repoOk = path.join(tmpBase, "repo-ok");
    const repoConflict = path.join(tmpBase, "repo-conflict");
    const configFile = path.join(tmpBase, "repos.json");

    fs.mkdirSync(repoOk, { recursive: true });
    fs.mkdirSync(repoConflict, { recursive: true });
    fs.writeFileSync(
      configFile,
      JSON.stringify([
        {
          path: repoOk,
          repoType: "code",
          sourceBranch: "release",
          knowledgeBranch: "docs",
        },
        {
          path: repoConflict,
          repoType: "code",
          sourceBranch: "release",
          knowledgeBranch: "docs",
        },
      ])
    );

    try {
      const fakeDriver = new FakeProcessDriver();
      const executedCommands: string[] = [];

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        const cwd = spec.cwd;

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "fetch --filter=blob:none origin" || cmd === "fetch origin") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cwd === repoOk) {
          if (cmd === "status --porcelain") {
            handle.emitOutput("stdout", "");
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "rev-parse --verify origin/docs" || cmd === "rev-parse --verify refs/heads/docs") {
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "checkout docs" || cmd === "merge --ff-only origin/docs") {
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "merge --no-edit origin/release") {
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "push origin docs") {
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "rev-parse HEAD") {
            handle.emitOutput("stdout", "cccc111122223333444455556666777788889999\n");
            handle.emitExit({ code: 0, signal: null });
          } else {
            handle.emitExit({ code: 0, signal: null });
          }
        } else if (cwd === repoConflict) {
          if (cmd === "status --porcelain") {
            if (executedCommands.includes(`[${repoConflict}] merge --no-edit origin/release`)) {
              handle.emitOutput("stdout", "UU docs/flow.md\nUU docs/api.md\n");
            } else {
              handle.emitOutput("stdout", "");
            }
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "rev-parse --verify origin/docs" || cmd === "rev-parse --verify refs/heads/docs") {
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "checkout docs" || cmd === "merge --ff-only origin/docs") {
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "merge --no-edit origin/release") {
            executedCommands.push(`[${repoConflict}] merge --no-edit origin/release`);
            handle.emitOutput("stderr", "CONFLICT (content): Merge conflict in docs/flow.md\n");
            handle.emitExit({ code: 1, signal: null });
          } else if (cmd === "merge --abort") {
            handle.emitExit({ code: 0, signal: null });
          } else {
            handle.emitExit({ code: 0, signal: null });
          }
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(syncAction, {
        config: configFile,
      });

      assert.equal(res.batch, true);
      assert.equal(res.status, "conflict");
      assert.equal(res.summary?.total, 2);
      assert.equal(res.summary?.syncedCount, 1);
      assert.equal(res.summary?.conflictCount, 1);
      assert.equal(res.summary?.errorCount, 0);
      assert.equal(res.conflicts?.length, 1);
      assert.equal(res.conflicts?.[0]?.path, repoConflict);
      assert.deepEqual(res.conflicts?.[0]?.conflictFiles, ["docs/flow.md", "docs/api.md"]);
      assert.ok(res.message.includes("merge conflicts in 1 repository"));
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("batch synchronizes with error repository and summarizes as error status", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "sync-batch-err-"));
    const repoOk = path.join(tmpBase, "repo-ok");
    const repoDirty = path.join(tmpBase, "repo-dirty");
    const configFile = path.join(tmpBase, "repos.json");

    fs.mkdirSync(repoOk, { recursive: true });
    fs.mkdirSync(repoDirty, { recursive: true });
    fs.writeFileSync(
      configFile,
      JSON.stringify([
        { path: repoOk, repoType: "system_knowledge", sourceBranch: "master" },
        { path: repoDirty, repoType: "code", sourceBranch: "release" },
      ])
    );

    try {
      const fakeDriver = new FakeProcessDriver();

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        const cwd = spec.cwd;

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cwd === repoDirty) {
          if (cmd === "status --porcelain") {
            handle.emitOutput("stdout", " M uncommitted.ts\n");
            handle.emitExit({ code: 0, signal: null });
          } else {
            handle.emitExit({ code: 0, signal: null });
          }
        } else if (cwd === repoOk) {
          if (cmd === "status --porcelain") {
            handle.emitOutput("stdout", "");
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "fetch --filter=blob:none origin" || cmd === "fetch origin") {
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "rev-parse --verify refs/heads/master") {
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "checkout master" || cmd === "merge --ff-only origin/master") {
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "rev-parse HEAD") {
            handle.emitOutput("stdout", "dddd111122223333444455556666777788889999\n");
            handle.emitExit({ code: 0, signal: null });
          } else {
            handle.emitExit({ code: 0, signal: null });
          }
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(syncAction, {
        config: configFile,
      });

      assert.equal(res.batch, true);
      assert.equal(res.status, "error");
      assert.equal(res.summary?.total, 2);
      assert.equal(res.summary?.syncedCount, 1);
      assert.equal(res.summary?.conflictCount, 0);
      assert.equal(res.summary?.errorCount, 1);
      assert.deepEqual(res.conflicts, []);
      assert.equal(res.results?.[1]?.status, "dirty_worktree");
      assert.ok(res.message.includes("1 error(s)"));
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("batch synchronizes by auto-generating repos.json from workspace when config file does not exist", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "sync-batch-ws-"));
    const repo1 = path.join(tmpBase, "repo1");
    const repo2 = path.join(tmpBase, "system-knowledge");
    fs.mkdirSync(path.join(repo1, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo2, ".git"), { recursive: true });

    const prevWorkspaceRoot = process.env.WORKSPACE_ROOT;
    process.env.WORKSPACE_ROOT = tmpBase;

    try {
      const fakeDriver = new FakeProcessDriver();

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", "");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "fetch --filter=blob:none origin" || cmd === "fetch origin") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "branch --list") {
          handle.emitOutput("stdout", "* master\n  release\n  docs\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "branch -r") {
          handle.emitOutput("stdout", "  origin/master\n  origin/release\n  origin/docs\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd.startsWith("rev-parse --verify")) {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd.startsWith("checkout") || cmd.startsWith("merge") || cmd.startsWith("push")) {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse HEAD") {
          handle.emitOutput("stdout", "eeee111122223333444455556666777788889999\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const targetConfigFile = path.join(tmpBase, "auto-generated-repos.json");
      assert.equal(fs.existsSync(targetConfigFile), false);

      const res = await runtime.run(syncAction, {
        config: targetConfigFile,
      });

      assert.equal(fs.existsSync(targetConfigFile), true);
      const generated = JSON.parse(fs.readFileSync(targetConfigFile, "utf8"));
      assert.equal(Array.isArray(generated), true);
      assert.equal(generated.length, 2);
      assert.equal(generated[0].path, repo1);
      assert.equal(generated[0].repoType, "code");
      assert.equal(generated[0].sourceBranch, "release");
      assert.equal(generated[0].knowledgeBranch, "docs");
      assert.equal(generated[1].path, repo2);
      assert.equal(generated[1].repoType, "system_knowledge");
      assert.equal(generated[1].sourceBranch, "master");

      assert.equal(res.batch, true);
      assert.equal(res.status, "success");
      assert.equal(res.summary?.total, 2);
      assert.equal(res.summary?.syncedCount, 2);
      assert.equal(res.summary?.conflictCount, 0);
      assert.equal(res.summary?.errorCount, 0);
      assert.equal(res.results?.length, 2);
    } finally {
      if (prevWorkspaceRoot !== undefined) {
        process.env.WORKSPACE_ROOT = prevWorkspaceRoot;
      } else {
        delete process.env.WORKSPACE_ROOT;
      }
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("returns error envelope when configuration file is invalid or no repositories found", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "sync-batch-invalid-"));
    const invalidConfigFile = path.join(tmpBase, "invalid.json");
    fs.writeFileSync(invalidConfigFile, "{ not an array }");

    const prevWorkspaceRoot = process.env.WORKSPACE_ROOT;
    delete process.env.WORKSPACE_ROOT;

    try {
      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: new FakeProcessDriver() }),
      });

      // 1. Invalid JSON config
      const resInvalid = await runtime.run(syncAction, {
        config: invalidConfigFile,
      });
      assert.equal(resInvalid.batch, true);
      assert.equal(resInvalid.status, "error");
      assert.equal(resInvalid.summary?.errorCount, 1);
      assert.ok(resInvalid.message.includes("Failed to read configuration file"));

      // 2. No repositories found (no config, no WORKSPACE_ROOT)
      const resEmpty = await runtime.run(syncAction, {});
      assert.equal(resEmpty.batch, true);
      assert.equal(resEmpty.status, "error");
      assert.equal(resEmpty.summary?.total, 0);
      assert.ok(resEmpty.message.includes("No repositories found"));
    } finally {
      if (prevWorkspaceRoot !== undefined) {
        process.env.WORKSPACE_ROOT = prevWorkspaceRoot;
      }
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("automatically blobless-clones when target directory does not exist and url is provided", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "sync-clone-"));
    const targetDir = path.join(tmpBase, "cloned-repo");
    const remoteUrl = "https://github.com/example/order-service.git";

    try {
      const fakeDriver = new FakeProcessDriver();
      const executedCommands: string[] = [];
      const commandTimeouts: { cmd: string; timeoutMs?: number }[] = [];

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        executedCommands.push(cmd);

        if (cmd.startsWith("clone --filter=blob:none")) {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", "");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify refs/heads/release") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "checkout release") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "fetch --filter=blob:none origin" || cmd === "fetch origin") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify origin/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify refs/heads/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "checkout docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "merge --ff-only origin/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "merge --no-edit origin/release") {
          handle.emitOutput("stdout", "Merge made by the 'ort' strategy.\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "push origin docs") {
          handle.emitOutput("stdout", "To origin\n   abc..def  docs -> docs\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse HEAD") {
          handle.emitOutput("stdout", "9999888877776666555544443333222211110000\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const platform = createTestPlatform({ processDriver: fakeDriver });
      const origExecute = (platform.process as any).processManager.runExecutor.execute.bind(
        (platform.process as any).processManager.runExecutor
      );
      (platform.process as any).processManager.runExecutor.execute = async (input: any, call: any) => {
        commandTimeouts.push({
          cmd: input.spec.args?.join(" ") ?? "",
          timeoutMs: input.timeoutMs,
        });
        return origExecute(input, call);
      };

      const runtime = createTestRuntime({
        platform,
      });

      const res = await runtime.run(syncAction, {
        path: targetDir,
        url: remoteUrl,
        repoType: "code",
        sourceBranch: "release",
        knowledgeBranch: "docs",
      });

      assert.equal(res.status, "success");
      assert.equal(res.cloned, true);
      assert.equal(res.repoType, "code");
      assert.equal(res.sourceBranch, "release");
      assert.equal(res.knowledgeBranch, "docs");
      assert.equal(res.currentCommit, "9999888877776666555544443333222211110000");
      assert.equal(res.initializedBranch, false);

      assert.ok(
        executedCommands.some(
          (c) => c.startsWith("clone --filter=blob:none") && c.includes(remoteUrl) && c.includes(targetDir)
        ),
        "Must trigger blobless clone with url and target path"
      );
      assert.ok(executedCommands.includes("push origin docs"));

      const cloneRun = commandTimeouts.find((c) => c.cmd.startsWith("clone"));
      assert.ok(cloneRun, "Clone command must be executed");
      assert.equal(cloneRun.timeoutMs, 300000, "Clone operation must default to 300000ms (5 minutes)");

      const nonCloneRuns = commandTimeouts.filter((c) => !c.cmd.startsWith("clone"));
      assert.ok(nonCloneRuns.length > 0, "Non-clone git commands must be executed");
      for (const nonClone of nonCloneRuns) {
        assert.equal(nonClone.timeoutMs, 30000, "Regular git operations must use default 30000ms");
      }
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("automatically falls back to standard clone when blobless filter is unsupported by server", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "sync-clone-fallback-"));
    const targetDir = path.join(tmpBase, "cloned-repo-fallback");
    const remoteUrl = "https://github.com/example/legacy-repo.git";

    try {
      const fakeDriver = new FakeProcessDriver();
      const executedCommands: string[] = [];

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        executedCommands.push(cmd);

        if (cmd.startsWith("clone --filter=blob:none")) {
          handle.emitOutput("stderr", "fatal: server does not support partial clone filter\n");
          handle.emitExit({ code: 128, signal: null });
        } else if (cmd.startsWith("clone") && !cmd.includes("--filter=blob:none")) {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", "");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify refs/heads/release") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "checkout release") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "fetch --filter=blob:none origin" || cmd === "fetch origin") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify origin/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify refs/heads/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "checkout docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "merge --ff-only origin/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "merge --no-edit origin/release") {
          handle.emitOutput("stdout", "Merge made by the 'ort' strategy.\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "push origin docs") {
          handle.emitOutput("stdout", "To origin\n   abc..def  docs -> docs\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse HEAD") {
          handle.emitOutput("stdout", "bbbb222233334444555566667777888899990000\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const platform = createTestPlatform({ processDriver: fakeDriver });
      const commandTimeouts: { cmd: string; timeoutMs?: number }[] = [];
      const origExecute = (platform.process as any).processManager.runExecutor.execute.bind(
        (platform.process as any).processManager.runExecutor
      );
      (platform.process as any).processManager.runExecutor.execute = async (input: any, call: any) => {
        commandTimeouts.push({
          cmd: input.spec.args?.join(" ") ?? "",
          timeoutMs: input.timeoutMs,
        });
        return origExecute(input, call);
      };

      const runtime = createTestRuntime({
        platform,
      });

      const res = await runtime.run(syncAction, {
        path: targetDir,
        url: remoteUrl,
        cloneTimeoutMs: 600000,
        repoType: "code",
        sourceBranch: "release",
        knowledgeBranch: "docs",
      });

      assert.equal(res.status, "success");
      assert.equal(res.cloned, true);
      assert.equal(res.currentCommit, "bbbb222233334444555566667777888899990000");

      assert.ok(
        executedCommands.some((c) => c.startsWith("clone --filter=blob:none")),
        "Must attempt blobless clone first"
      );
      assert.ok(
        executedCommands.some((c) => c.startsWith("clone") && !c.includes("--filter=blob:none")),
        "Must fallback to standard clone without filter"
      );
      assert.ok(executedCommands.includes("push origin docs"));

      const cloneRuns = commandTimeouts.filter((c) => c.cmd.startsWith("clone"));
      assert.ok(cloneRuns.length >= 2, "Both blobless and fallback clone must be recorded");
      for (const run of cloneRuns) {
        assert.equal(run.timeoutMs, 600000, "Clone operations must apply custom cloneTimeoutMs (600000ms)");
      }

      const nonCloneRuns = commandTimeouts.filter((c) => !c.cmd.startsWith("clone"));
      assert.ok(nonCloneRuns.length > 0, "Non-clone git commands must be executed");
      for (const run of nonCloneRuns) {
        assert.equal(run.timeoutMs, 30000, "Regular git operations must use default 30000ms");
      }
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("returns error status when target directory does not exist and no url is provided", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "sync-no-url-"));
    const nonExistentPath = path.join(tmpBase, "does-not-exist");

    try {
      const fakeDriver = new FakeProcessDriver();
      const executedCommands: string[] = [];

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        executedCommands.push(spec.args.join(" "));
        handle.emitExit({ code: 0, signal: null });
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(syncAction, {
        path: nonExistentPath,
      });

      assert.equal(res.status, "error");
      assert.equal(res.cloned, false);
      assert.ok(res.message.includes("Target path does not exist and no remote url provided for clone"));
      assert.equal(executedCommands.length, 0, "No git commands should be run when path does not exist and no url is provided");
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("batch synchronizes with automatic clone when repository path does not exist and url is provided in configuration", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "sync-batch-clone-"));
    const repoCloned = path.join(tmpBase, "cloned-service");
    const configFile = path.join(tmpBase, "repos.json");

    fs.writeFileSync(
      configFile,
      JSON.stringify([
        {
          path: repoCloned,
          url: "https://github.com/example/cloned-service.git",
          repoType: "system_knowledge",
          sourceBranch: "master",
          cloneTimeoutMs: 450000,
        },
      ])
    );

    try {
      const fakeDriver = new FakeProcessDriver();
      const executedCommands: string[] = [];
      const commandTimeouts: { cmd: string; timeoutMs?: number }[] = [];

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        executedCommands.push(cmd);

        if (cmd.startsWith("clone --filter=blob:none")) {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", "");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "fetch --filter=blob:none origin" || cmd === "fetch origin") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify refs/heads/master") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "checkout master" || cmd === "merge --ff-only origin/master") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse HEAD") {
          handle.emitOutput("stdout", "eeee111122223333444455556666777788889999\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const platform = createTestPlatform({ processDriver: fakeDriver });
      const origExecute = (platform.process as any).processManager.runExecutor.execute.bind(
        (platform.process as any).processManager.runExecutor
      );
      (platform.process as any).processManager.runExecutor.execute = async (input: any, call: any) => {
        commandTimeouts.push({
          cmd: input.spec.args?.join(" ") ?? "",
          timeoutMs: input.timeoutMs,
        });
        return origExecute(input, call);
      };

      const runtime = createTestRuntime({
        platform,
      });

      const res = await runtime.run(syncAction, {
        config: configFile,
      });

      assert.equal(res.batch, true);
      assert.equal(res.status, "success");
      assert.equal(res.summary?.total, 1);
      assert.equal(res.summary?.syncedCount, 1);
      assert.equal(res.results?.[0]?.cloned, true);
      assert.ok(executedCommands.some((c) => c.startsWith("clone --filter=blob:none")));

      const cloneRun = commandTimeouts.find((c) => c.cmd.startsWith("clone"));
      assert.ok(cloneRun, "Clone command must be executed in batch mode");
      assert.equal(cloneRun.timeoutMs, 450000, "Batch clone must use cloneTimeoutMs configured in repos.json (450000ms)");

      const nonCloneRuns = commandTimeouts.filter((c) => !c.cmd.startsWith("clone"));
      assert.ok(nonCloneRuns.length > 0, "Non-clone git commands must be executed");
      for (const nonClone of nonCloneRuns) {
        assert.equal(nonClone.timeoutMs, 30000, "Regular git operations must use default 30000ms");
      }
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});

