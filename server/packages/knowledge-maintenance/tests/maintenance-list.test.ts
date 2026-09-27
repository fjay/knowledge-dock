import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestRuntime, createTestPlatform, FakeProcessDriver } from "@actiondock/testing";
import { encodeStateKey } from "@actiondock/sdk";
import listAction from "../actions/maintenance-list.ts";

describe("maintenance.list", () => {
  it("implements Strategy B: initial run without checkpoint requests full inventory", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-init-"));
    try {
      const fakeDriver = new FakeProcessDriver();

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "branch -a --format=%(refname:short)") {
          handle.emitOutput("stdout", "release\nmain\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse release^{commit}") {
          handle.emitOutput("stdout", "e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "config --get remote.origin.url") {
          handle.emitOutput("stdout", "git@github.com:myorg/order-service.git\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-list --count e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3") {
          handle.emitOutput("stdout", "128\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(listAction, { path: tmpDir });

      assert.equal(res.hasChanges, true);
      assert.equal(res.from, null);
      assert.equal(res.to, "e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3");
      assert.equal(res.repo, "order-service");
      assert.equal(res.branch, "release");
      assert.equal(res.commitCount, 128);
      assert.equal(res.initialInventoryRequired, true);
      assert.deepEqual(res.commits, []);
      assert.ok(res.message.includes("full inventory required"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports no changes when checkpoint commit equals HEAD", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-noupdate-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const headCommit = "1111222233334444555566667777888899990000";

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse release^{commit}") {
          handle.emitOutput("stdout", `${headCommit}\n`);
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "config --get remote.origin.url") {
          handle.emitOutput("stdout", "https://github.com/myorg/demo-repo\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      // Pre-seed checkpoint in state
      await runtime.state.set(encodeStateKey("checkpoints", "demo-repo"), {
        commit: headCommit,
        updatedAt: "2026-09-24T00:00:00Z",
      });

      const res = await runtime.run(listAction, { path: tmpDir, branch: "release" });

      assert.equal(res.hasChanges, false);
      assert.equal(res.from, headCommit);
      assert.equal(res.to, headCommit);
      assert.equal(res.commitCount, 0);
      assert.deepEqual(res.commits, []);
      assert.equal(res.initialInventoryRequired, false);
      assert.ok(res.message.includes("up to date"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("extracts commits and diff stats when changes are detected", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-changes-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const fromCommit = "aaaa111122223333444455556666777788889999";
      const toCommit = "bbbb111122223333444455556666777788889999";

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse release^{commit}") {
          handle.emitOutput("stdout", `${toCommit}\n`);
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "config --get remote.origin.url") {
          handle.emitOutput("stdout", "git@github.com:myorg/demo-repo.git\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd.includes("log --pretty=format:%H%x09%h%x09%an <%ae>%x09%aI%x09%s")) {
          const logLines = [
            `${toCommit}\tbbbb111\tAlice <alice@test.com>\t2026-09-24T08:00:00Z\tfeat: update budget validation logic`,
            `cccc111122223333444455556666777788889999\tcccc111\tBob <bob@test.com>\t2026-09-24T07:30:00Z\tfix: handle null payment response`,
          ].join("\n");
          handle.emitOutput("stdout", logLines + "\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd.includes("diff --stat")) {
          const diffOutput = [
            " src/campaign/budget.ts | 30 ++++++++++++++++++++++++++----",
            " src/payment/handler.ts |  8 ++++----",
            " 2 files changed, 30 insertions(+), 8 deletions(-)",
          ].join("\n");
          handle.emitOutput("stdout", diffOutput + "\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      // Pre-seed checkpoint in state
      await runtime.state.set(encodeStateKey("checkpoints", "demo-repo"), {
        commit: fromCommit,
        updatedAt: "2026-09-24T00:00:00Z",
      });

      const res = await runtime.run(listAction, { path: tmpDir, branch: "release" });

      assert.equal(res.hasChanges, true);
      assert.equal(res.from, fromCommit);
      assert.equal(res.to, toCommit);
      assert.equal(res.commitCount, 2);
      assert.equal(res.commits?.length, 2);
      assert.equal(res.commits[0]?.shortHash, "bbbb111");
      assert.equal(res.commits[0]?.message, "feat: update budget validation logic");

      assert.equal(res.changedFilesSummary?.filesChanged, 2);
      assert.equal(res.changedFilesSummary?.insertions, 30);
      assert.equal(res.changedFilesSummary?.deletions, 8);
      assert.equal(res.changedFilesSummary?.files?.length, 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws INVALID_REPO error when target path is not a git repository", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-notgit-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      fakeDriver.onSpawn = (handle: any) => {
        handle.emitOutput("stderr", "fatal: not a git repository\n");
        handle.emitExit({ code: 128, signal: null });
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      await assert.rejects(
        () => runtime.run(listAction, { path: tmpDir }),
        (err: any) => err.code === "INVALID_REPO"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("batch scans multiple repositories from config file with mixed initial, changed, and upToDate states", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "list-batch-mixed-"));
    const repoInit = path.join(tmpBase, "order-service");
    const repoChanged = path.join(tmpBase, "user-service");
    const repoUpToDate = path.join(tmpBase, "system-knowledge");
    const configFile = path.join(tmpBase, "repos.json");

    fs.mkdirSync(repoInit, { recursive: true });
    fs.mkdirSync(repoChanged, { recursive: true });
    fs.mkdirSync(repoUpToDate, { recursive: true });

    fs.writeFileSync(
      configFile,
      JSON.stringify([
        { path: repoInit, branch: "release" },
        { path: repoChanged, branch: "release" },
        { path: repoUpToDate, branch: "master" },
      ])
    );

    const initHeadCommit = "1111111111111111111111111111111111111111";
    const changedPrevCommit = "2222222222222222222222222222222222222222";
    const changedHeadCommit = "3333333333333333333333333333333333333333";
    const upToDateCommit = "4444444444444444444444444444444444444444";

    try {
      const fakeDriver = new FakeProcessDriver();

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        const cwd = spec.cwd;

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cwd === repoInit) {
          if (cmd === "rev-parse release^{commit}") {
            handle.emitOutput("stdout", `${initHeadCommit}\n`);
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "config --get remote.origin.url") {
            handle.emitOutput("stdout", "https://github.com/myorg/order-service.git\n");
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === `rev-list --count ${initHeadCommit}`) {
            handle.emitOutput("stdout", "42\n");
            handle.emitExit({ code: 0, signal: null });
          } else {
            handle.emitExit({ code: 0, signal: null });
          }
        } else if (cwd === repoChanged) {
          if (cmd === "rev-parse release^{commit}") {
            handle.emitOutput("stdout", `${changedHeadCommit}\n`);
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "config --get remote.origin.url") {
            handle.emitOutput("stdout", "https://github.com/myorg/user-service.git\n");
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd.includes("log --pretty=format:")) {
            const logLine = `${changedHeadCommit}\t3333333\tAlice <alice@test.com>\t2026-09-24T08:00:00Z\tfeat: update user profile validation`;
            handle.emitOutput("stdout", logLine + "\n");
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd.includes("diff --stat")) {
            const diffOut = " src/user.ts | 5 +++++\n 1 file changed, 5 insertions(+)\n";
            handle.emitOutput("stdout", diffOut);
            handle.emitExit({ code: 0, signal: null });
          } else {
            handle.emitExit({ code: 0, signal: null });
          }
        } else if (cwd === repoUpToDate) {
          if (cmd === "rev-parse master^{commit}") {
            handle.emitOutput("stdout", `${upToDateCommit}\n`);
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "config --get remote.origin.url") {
            handle.emitOutput("stdout", "https://github.com/myorg/system-knowledge.git\n");
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

      // Pre-seed checkpoints
      await runtime.state.set(encodeStateKey("checkpoints", "user-service"), {
        commit: changedPrevCommit,
        updatedAt: "2026-09-24T00:00:00Z",
      });
      await runtime.state.set(encodeStateKey("checkpoints", "system-knowledge"), {
        commit: upToDateCommit,
        updatedAt: "2026-09-24T00:00:00Z",
      });

      const res = await runtime.run(listAction, {
        config: configFile,
      });

      assert.equal(res.batch, true);
      assert.equal(res.hasChanges, true);
      assert.equal(res.summary?.total, 3);
      assert.equal(res.summary?.initialCount, 1);
      assert.equal(res.summary?.changedCount, 1);
      assert.equal(res.summary?.upToDateCount, 1);
      assert.equal(res.summary?.errorCount, 0);

      assert.equal(res.results?.length, 3);
      assert.equal(res.results?.[0]?.status, "initial");
      assert.equal(res.results?.[0]?.repo, "order-service");
      assert.equal(res.results?.[0]?.hasChanges, true);
      assert.equal(res.results?.[0]?.initialInventoryRequired, true);
      assert.equal(res.results?.[0]?.commitCount, 42);

      assert.equal(res.results?.[1]?.status, "changed");
      assert.equal(res.results?.[1]?.repo, "user-service");
      assert.equal(res.results?.[1]?.hasChanges, true);
      assert.equal(res.results?.[1]?.commitCount, 1);
      assert.equal(res.results?.[1]?.commits?.[0]?.shortHash, "3333333");

      assert.equal(res.results?.[2]?.status, "upToDate");
      assert.equal(res.results?.[2]?.repo, "system-knowledge");
      assert.equal(res.results?.[2]?.hasChanges, false);
      assert.equal(res.results?.[2]?.commitCount, 0);

      assert.ok(res.message.includes("1 changed, 1 initial, 1 up to date"));
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("batch scan reports hasChanges false when all repositories are up to date", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "list-batch-uptodate-"));
    const repoA = path.join(tmpBase, "repo-a");
    const repoB = path.join(tmpBase, "repo-b");
    const configFile = path.join(tmpBase, "repos.json");

    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });

    fs.writeFileSync(
      configFile,
      JSON.stringify([
        { path: repoA, branch: "release" },
        { path: repoB, branch: "release" },
      ])
    );

    const commitA = "aaaa111122223333444455556666777788889999";
    const commitB = "bbbb111122223333444455556666777788889999";

    try {
      const fakeDriver = new FakeProcessDriver();

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        const cwd = spec.cwd;

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cwd === repoA) {
          if (cmd === "rev-parse release^{commit}") {
            handle.emitOutput("stdout", `${commitA}\n`);
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "config --get remote.origin.url") {
            handle.emitOutput("stdout", "https://github.com/myorg/repo-a.git\n");
            handle.emitExit({ code: 0, signal: null });
          } else {
            handle.emitExit({ code: 0, signal: null });
          }
        } else if (cwd === repoB) {
          if (cmd === "rev-parse release^{commit}") {
            handle.emitOutput("stdout", `${commitB}\n`);
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "config --get remote.origin.url") {
            handle.emitOutput("stdout", "https://github.com/myorg/repo-b.git\n");
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

      await runtime.state.set(encodeStateKey("checkpoints", "repo-a"), {
        commit: commitA,
      });
      await runtime.state.set(encodeStateKey("checkpoints", "repo-b"), {
        commit: commitB,
      });

      const res = await runtime.run(listAction, {
        config: configFile,
      });

      assert.equal(res.batch, true);
      assert.equal(res.hasChanges, false);
      assert.equal(res.summary?.total, 2);
      assert.equal(res.summary?.upToDateCount, 2);
      assert.equal(res.summary?.changedCount, 0);
      assert.equal(res.summary?.initialCount, 0);
      assert.equal(res.summary?.errorCount, 0);
      assert.ok(res.message.includes("All 2 repositories are up to date"));
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("batch scan handles repository errors gracefully and increments errorCount", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "list-batch-err-"));
    const repoOk = path.join(tmpBase, "repo-ok");
    const repoInvalid = path.join(tmpBase, "repo-invalid");
    const configFile = path.join(tmpBase, "repos.json");

    fs.mkdirSync(repoOk, { recursive: true });
    fs.mkdirSync(repoInvalid, { recursive: true });

    fs.writeFileSync(
      configFile,
      JSON.stringify([
        { path: repoOk, branch: "release" },
        { path: repoInvalid, branch: "release" },
      ])
    );

    const commitOk = "cccc111122223333444455556666777788889999";

    try {
      const fakeDriver = new FakeProcessDriver();

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        const cwd = spec.cwd;

        if (cwd === repoOk) {
          if (cmd === "rev-parse --is-inside-work-tree") {
            handle.emitOutput("stdout", "true\n");
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "rev-parse release^{commit}") {
            handle.emitOutput("stdout", `${commitOk}\n`);
            handle.emitExit({ code: 0, signal: null });
          } else if (cmd === "config --get remote.origin.url") {
            handle.emitOutput("stdout", "https://github.com/myorg/repo-ok.git\n");
            handle.emitExit({ code: 0, signal: null });
          } else {
            handle.emitExit({ code: 0, signal: null });
          }
        } else if (cwd === repoInvalid) {
          if (cmd === "rev-parse --is-inside-work-tree") {
            handle.emitOutput("stderr", "fatal: not a git repository\n");
            handle.emitExit({ code: 128, signal: null });
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

      await runtime.state.set(encodeStateKey("checkpoints", "repo-ok"), {
        commit: commitOk,
      });

      const res = await runtime.run(listAction, {
        config: configFile,
      });

      assert.equal(res.batch, true);
      assert.equal(res.hasChanges, false);
      assert.equal(res.summary?.total, 2);
      assert.equal(res.summary?.upToDateCount, 1);
      assert.equal(res.summary?.errorCount, 1);
      assert.equal(res.results?.[1]?.status, "error");
      assert.equal(res.results?.[1]?.hasChanges, false);
      assert.ok(res.message.includes("1 error(s)"));
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("batch scans by auto-generating repos.json from workspace when config file does not exist", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "list-batch-ws-"));
    const repo1 = path.join(tmpBase, "service-a");
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
        } else if (cmd === "branch -a --format=%(refname:short)") {
          handle.emitOutput("stdout", "release\nmaster\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd.startsWith("rev-parse") && cmd.includes("^{commit}")) {
          handle.emitOutput("stdout", "5555111122223333444455556666777788889999\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "config --get remote.origin.url") {
          handle.emitExit({ code: 1, signal: null });
        } else if (cmd.startsWith("rev-list --count")) {
          handle.emitOutput("stdout", "10\n");
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

      const res = await runtime.run(listAction, {
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
      assert.equal(res.hasChanges, true);
      assert.equal(res.summary?.total, 2);
      assert.equal(res.summary?.initialCount, 2);
      assert.equal(res.results?.length, 2);
      assert.equal(res.results?.[0]?.path, repo1);
      assert.equal(res.results?.[1]?.path, repo2);
    } finally {
      if (prevWorkspaceRoot !== undefined) {
        process.env.WORKSPACE_ROOT = prevWorkspaceRoot;
      } else {
        delete process.env.WORKSPACE_ROOT;
      }
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("handles empty repository configuration and invalid config files gracefully", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "list-batch-empty-"));
    const emptyConfig = path.join(tmpBase, "empty.json");
    const invalidJson = path.join(tmpBase, "invalid.json");
    const nonArrayJson = path.join(tmpBase, "nonarray.json");

    fs.writeFileSync(emptyConfig, "[]");
    fs.writeFileSync(invalidJson, "{ not a valid json");
    fs.writeFileSync(nonArrayJson, JSON.stringify({ not: "an array" }));

    const prevWorkspaceRoot = process.env.WORKSPACE_ROOT;
    delete process.env.WORKSPACE_ROOT;

    try {
      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: new FakeProcessDriver() }),
      });

      // 1. Empty repository list
      const emptyRes = await runtime.run(listAction, {
        config: emptyConfig,
      });
      assert.equal(emptyRes.batch, true);
      assert.equal(emptyRes.hasChanges, false);
      assert.equal(emptyRes.summary?.total, 0);
      assert.equal(emptyRes.summary?.errorCount, 0);
      assert.deepEqual(emptyRes.results, []);
      assert.ok(emptyRes.message.includes("No repositories found"));

      // 2. Corrupted JSON file
      const invalidRes = await runtime.run(listAction, {
        config: invalidJson,
      });
      assert.equal(invalidRes.batch, true);
      assert.equal(invalidRes.hasChanges, false);
      assert.equal(invalidRes.summary?.errorCount, 1);
      assert.ok(invalidRes.message.includes("Failed to read configuration file"));

      // 3. Non-array JSON
      const nonArrayRes = await runtime.run(listAction, {
        config: nonArrayJson,
      });
      assert.equal(nonArrayRes.batch, true);
      assert.equal(nonArrayRes.hasChanges, false);
      assert.equal(nonArrayRes.summary?.errorCount, 1);
      assert.ok(nonArrayRes.message.includes("Invalid configuration file: expected JSON array"));
    } finally {
      if (prevWorkspaceRoot !== undefined) {
        process.env.WORKSPACE_ROOT = prevWorkspaceRoot;
      }
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
