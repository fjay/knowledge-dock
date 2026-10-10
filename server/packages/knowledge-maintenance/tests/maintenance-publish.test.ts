import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestRuntime, createTestPlatform, FakeProcessDriver } from "@actiondock/testing";
import publishAction from "../actions/maintenance-publish.ts";

describe("maintenance.publish", () => {
  it("returns no_changes when working tree is clean", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-clean-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "config --get remote.origin.url") {
          handle.emitOutput("stdout", "git@github.com:org/order-service.git\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd.startsWith("branch -a")) {
          handle.emitOutput("stdout", "release\ndocs\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", "");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(publishAction, {
        path: tmpDir,
      });

      assert.equal(res.status, "no_changes");
      assert.equal(res.committed, false);
      assert.equal(res.pushed, false);
      assert.equal(res.branch, "docs");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("stages, commits, and pushes modified files for system_knowledge repository", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-sys-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const executedCommands: string[] = [];

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        executedCommands.push(cmd);

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "config --get remote.origin.url") {
          handle.emitOutput("stdout", "git@github.com:org/system-knowledge.git\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd.startsWith("branch -a")) {
          handle.emitOutput("stdout", "master\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", " M index.md\n?? 实名认证/flow/flow-verify.md\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --abbrev-ref HEAD") {
          handle.emitOutput("stdout", "master\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "add -A") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "diff --cached --name-only") {
          handle.emitOutput("stdout", "index.md\n实名认证/flow/flow-verify.md\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd.startsWith("commit -m")) {
          handle.emitOutput("stdout", "[master a1b2c3d] docs(system): sync payment domain flow\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse HEAD") {
          handle.emitOutput("stdout", "a1b2c3d4e5f607182930415263748596a7b8c9d0\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "push origin master") {
          handle.emitOutput("stdout", "To origin\n   1111222..a1b2c3d  master -> master\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(publishAction, {
        path: tmpDir,
        repoType: "system_knowledge",
        message: "docs(system): sync payment domain flow",
      });

      assert.equal(res.status, "success");
      assert.equal(res.committed, true);
      assert.equal(res.pushed, true);
      assert.equal(res.branch, "master");
      assert.equal(res.commit, "a1b2c3d4e5f607182930415263748596a7b8c9d0");
      assert.equal(res.files?.length, 2);

      assert.ok(executedCommands.includes("add -A"));
      assert.ok(executedCommands.includes("push origin master"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles push: false and leaves commit local", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-nopush-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const executedCommands: string[] = [];

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        executedCommands.push(cmd);

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "config --get remote.origin.url") {
          handle.emitOutput("stdout", "git@github.com:org/order-service.git\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd.startsWith("branch -a")) {
          handle.emitOutput("stdout", "release\ndocs\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", " M docs/knowledge/overview.md\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --abbrev-ref HEAD") {
          handle.emitOutput("stdout", "docs\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "add -A") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "diff --cached --name-only") {
          handle.emitOutput("stdout", "docs/knowledge/overview.md\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd.startsWith("commit -m")) {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse HEAD") {
          handle.emitOutput("stdout", "feedcafe00001111222233334444555566667777\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(publishAction, {
        path: tmpDir,
        push: false,
      });

      assert.equal(res.status, "success");
      assert.equal(res.committed, true);
      assert.equal(res.pushed, false);
      assert.ok(!executedCommands.some((c) => c.startsWith("push")));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL from config when committing", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-env-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      let commitEnv: Record<string, string> | undefined;

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "config --get remote.origin.url") {
          handle.emitOutput("stdout", "git@github.com:org/order-service.git\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd.startsWith("branch -a")) {
          handle.emitOutput("stdout", "release\ndocs\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", " M docs/knowledge/overview.md\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --abbrev-ref HEAD") {
          handle.emitOutput("stdout", "docs\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "add -A") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "diff --cached --name-only") {
          handle.emitOutput("stdout", "docs/knowledge/overview.md\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd.startsWith("commit -m")) {
          commitEnv = spec.env?.set;
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse HEAD") {
          handle.emitOutput("stdout", "commit1234567890123456789012345678901234\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "push origin docs") {
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        config: {
          GIT_AUTHOR_NAME: "DevOps Bot",
          GIT_AUTHOR_EMAIL: "devops@example.com",
        },
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(publishAction, {
        path: tmpDir,
      });

      assert.equal(res.status, "success");
      assert.equal(res.committed, true);
      assert.equal(commitEnv?.GIT_AUTHOR_NAME, "DevOps Bot");
      assert.equal(commitEnv?.GIT_AUTHOR_EMAIL, "devops@example.com");
      assert.equal(commitEnv?.GIT_COMMITTER_NAME, "DevOps Bot");
      assert.equal(commitEnv?.GIT_COMMITTER_EMAIL, "devops@example.com");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves to main branch by default when repoType is inbox", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-inbox-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "config --get remote.origin.url") {
          handle.emitOutput("stdout", "git@github.com:org/knowledge-inbox.git\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd.startsWith("branch -a")) {
          handle.emitOutput("stdout", "main\norigin/main\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", "");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify origin/main") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-list origin/main..main") {
          handle.emitOutput("stdout", "");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(publishAction, {
        path: tmpDir,
        repoType: "inbox",
      });

      assert.equal(res.status, "no_changes");
      assert.equal(res.committed, false);
      assert.equal(res.pushed, false);
      assert.equal(res.branch, "main");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("pushes unpushed commits and returns pushed: true when working tree is clean", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-unpushed-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const executedCommands: string[] = [];

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        executedCommands.push(cmd);

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "config --get remote.origin.url") {
          handle.emitOutput("stdout", "git@github.com:org/knowledge-inbox.git\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd.startsWith("branch -a")) {
          handle.emitOutput("stdout", "main\norigin/main\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", "");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify origin/main") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-list origin/main..main") {
          handle.emitOutput("stdout", "c0ffee112233445566778899aabbccddeeff0011\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "push origin main") {
          handle.emitOutput("stdout", "To origin\n   1111222..c0ffee1  main -> main\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(publishAction, {
        path: tmpDir,
        repoType: "inbox",
        push: true,
      });

      assert.equal(res.status, "success");
      assert.equal(res.committed, false);
      assert.equal(res.pushed, true);
      assert.equal(res.branch, "main");
      assert.ok(res.message.includes("origin/main"));
      assert.ok(executedCommands.includes("push origin main"));
      assert.ok(!executedCommands.some((c) => c.startsWith("commit")));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves to current active main branch for system_knowledge repository when branch is omitted", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-sys-main-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const executedCommands: string[] = [];

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        executedCommands.push(cmd);

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "config --get remote.origin.url") {
          handle.emitOutput("stdout", "git@github.com:org/system-knowledge.git\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "branch --show-current") {
          handle.emitOutput("stdout", "main\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", " M index.md\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --abbrev-ref HEAD") {
          handle.emitOutput("stdout", "main\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "add -A") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "diff --cached --name-only") {
          handle.emitOutput("stdout", "index.md\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd.startsWith("commit -m")) {
          handle.emitOutput("stdout", "[main a1b2c3d] docs(system): sync payment domain flow\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse HEAD") {
          handle.emitOutput("stdout", "a1b2c3d4e5f607182930415263748596a7b8c9d0\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "push origin main") {
          handle.emitOutput("stdout", "To origin\n   1111222..a1b2c3d  main -> main\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(publishAction, {
        path: tmpDir,
        repoType: "system_knowledge",
        message: "docs(system): sync payment domain flow",
      });

      assert.equal(res.status, "success");
      assert.equal(res.committed, true);
      assert.equal(res.pushed, true);
      assert.equal(res.branch, "main");
      assert.equal(res.commit, "a1b2c3d4e5f607182930415263748596a7b8c9d0");

      assert.ok(executedCommands.includes("push origin main"));
      assert.ok(!executedCommands.some((c) => c.includes("checkout master")));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("dynamically resolves to origin/HEAD default branch when in detached HEAD state", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-detached-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const executedCommands: string[] = [];

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        executedCommands.push(cmd);

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "config --get remote.origin.url") {
          handle.emitOutput("stdout", "git@github.com:org/system-knowledge.git\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "branch --show-current") {
          handle.emitOutput("stdout", "");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --abbrev-ref HEAD") {
          handle.emitOutput("stdout", "HEAD\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "symbolic-ref --short refs/remotes/origin/HEAD") {
          handle.emitOutput("stdout", "origin/main\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", " M index.md\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify main") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "checkout main") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "add -A") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "diff --cached --name-only") {
          handle.emitOutput("stdout", "index.md\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd.startsWith("commit -m")) {
          handle.emitOutput("stdout", "[main a1b2c3d] docs(system): sync payment domain flow\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse HEAD") {
          handle.emitOutput("stdout", "a1b2c3d4e5f607182930415263748596a7b8c9d0\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "push origin main") {
          handle.emitOutput("stdout", "To origin\n   1111222..a1b2c3d  main -> main\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(publishAction, {
        path: tmpDir,
        repoType: "system_knowledge",
        message: "docs(system): sync payment domain flow",
      });

      assert.equal(res.status, "success");
      assert.equal(res.branch, "main");
      assert.ok(executedCommands.includes("symbolic-ref --short refs/remotes/origin/HEAD"));
      assert.ok(executedCommands.includes("push origin main"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
