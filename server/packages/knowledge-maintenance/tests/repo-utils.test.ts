import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseDiffStat,
  parseGitLog,
  resolveRepoPath,
  ensureReposConfigFile,
} from "../src/repo-utils.ts";

describe("repo-utils", () => {
  describe("parseDiffStat", () => {
    it("parses normal diff stat with additions and deletions", () => {
      const output = [
        " src/campaign/budget.ts | 30 ++++++++++++++++++++++++++----",
        " src/auth/handler.ts    | 10 +++++-----",
        " 2 files changed, 35 insertions(+), 5 deletions(-)",
      ].join("\n");

      const res = parseDiffStat(output);
      assert.equal(res.filesChanged, 2);
      assert.equal(res.insertions, 35);
      assert.equal(res.deletions, 5);
      assert.equal(res.files.length, 2);
      assert.equal(res.files[0]?.file, "src/campaign/budget.ts");
      assert.equal(res.files[1]?.file, "src/auth/handler.ts");
    });

    it("parses diff stat with only insertions", () => {
      const output = [
        " docs/intro.md | 20 ++++++++++++++++++++",
        " 1 file changed, 20 insertions(+)",
      ].join("\n");

      const res = parseDiffStat(output);
      assert.equal(res.filesChanged, 1);
      assert.equal(res.insertions, 20);
      assert.equal(res.deletions, 0);
    });

    it("parses empty or empty lines gracefully", () => {
      const res = parseDiffStat("");
      assert.equal(res.filesChanged, 0);
      assert.equal(res.insertions, 0);
      assert.equal(res.deletions, 0);
      assert.deepEqual(res.files, []);
    });
  });

  describe("parseGitLog", () => {
    it("parses formatted tab-delimited git log", () => {
      const output = [
        "1111222233334444555566667777888899990000\t1111222\tAlice <alice@test.com>\t2026-09-24T08:00:00Z\tfeat: new feature",
        "2222333344445555666677778888999900001111\t2222333\tBob <bob@test.com>\t2026-09-24T07:00:00Z\tfix: bug fix",
      ].join("\n");

      const res = parseGitLog(output);
      assert.equal(res.length, 2);
      assert.equal(res[0]?.hash, "1111222233334444555566667777888899990000");
      assert.equal(res[0]?.shortHash, "1111222");
      assert.equal(res[0]?.author, "Alice <alice@test.com>");
      assert.equal(res[0]?.date, "2026-09-24T08:00:00Z");
      assert.equal(res[0]?.message, "feat: new feature");
    });

    it("returns empty array on empty input", () => {
      assert.deepEqual(parseGitLog(""), []);
      assert.deepEqual(parseGitLog("   \n\n"), []);
    });
  });

  describe("resolveRepoPath", () => {
    it("resolves existing directory path", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "util-path-"));
      try {
        const resolved = resolveRepoPath(tmpDir);
        assert.equal(resolved, path.resolve(tmpDir));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("throws on non-existent path", () => {
      assert.throws(
        () => resolveRepoPath("/non/existent/path/here"),
        (err: any) => err.code === "PATH_NOT_FOUND"
      );
    });

    it("returns resolved path on non-existent path when allowNonExistent is true", () => {
      const nonExistentPath = "/non/existent/path/here/12345";
      const resolved = resolveRepoPath(nonExistentPath, { allowNonExistent: true });
      assert.equal(resolved, path.resolve(nonExistentPath));
    });

    it("throws when path is a file instead of directory", () => {
      const tmpFile = path.join(os.tmpdir(), `temp-file-${Date.now()}.txt`);
      fs.writeFileSync(tmpFile, "content");
      try {
        assert.throws(
          () => resolveRepoPath(tmpFile),
          (err: any) => err.code === "NOT_A_DIRECTORY"
        );
      } finally {
        fs.rmSync(tmpFile, { force: true });
      }
    });

    it("enforces workspace sandbox isolation when WORKSPACE_ROOT is configured", () => {
      const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "util-sandbox-ws-"));
      const repoInside = path.join(tmpWs, "inside-repo");
      fs.mkdirSync(repoInside, { recursive: true });
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "util-sandbox-out-"));

      const prevWs = process.env.WORKSPACE_ROOT;
      process.env.WORKSPACE_ROOT = tmpWs;

      try {
        // Path inside workspace root resolves successfully
        const resolved = resolveRepoPath(repoInside);
        assert.equal(resolved, path.resolve(repoInside));

        // Path outside workspace root throws PATH_FORBIDDEN (403)
        assert.throws(
          () => resolveRepoPath(outsideDir),
          (err: any) => err.code === "PATH_FORBIDDEN" && err.status === 403
        );

        // Path traversal escaping workspace root throws PATH_FORBIDDEN (403)
        const traversalPath = path.join(repoInside, "..", "..", "etc");
        assert.throws(
          () => resolveRepoPath(traversalPath),
          (err: any) => err.code === "PATH_FORBIDDEN" && err.status === 403
        );
      } finally {
        if (prevWs !== undefined) {
          process.env.WORKSPACE_ROOT = prevWs;
        } else {
          delete process.env.WORKSPACE_ROOT;
        }
        fs.rmSync(tmpWs, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("blocks symlink escaping workspace root to an outside directory", () => {
      const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "util-symlink-ws-"));
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "util-symlink-out-"));
      const symlinkPath = path.join(tmpWs, "escaped-link");
      fs.symlinkSync(outsideDir, symlinkPath, "dir");

      const prevWs = process.env.WORKSPACE_ROOT;
      process.env.WORKSPACE_ROOT = tmpWs;

      try {
        assert.throws(
          () => resolveRepoPath(symlinkPath),
          (err: any) =>
            err.code === "PATH_FORBIDDEN" &&
            err.status === 403 &&
            err.message.includes("Path or symlink target is outside workspace root")
        );
      } finally {
        if (prevWs !== undefined) {
          process.env.WORKSPACE_ROOT = prevWs;
        } else {
          delete process.env.WORKSPACE_ROOT;
        }
        fs.rmSync(tmpWs, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("blocks dangling symlink and ancestor symlink escaping workspace when allowNonExistent is true", () => {
      const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "util-dangling-ws-"));
      const outsideNonExistent = path.join(os.tmpdir(), `non-existent-${Date.now()}`);
      const danglingLink = path.join(tmpWs, "dangling-link");
      fs.symlinkSync(outsideNonExistent, danglingLink);

      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "util-outside-anc-"));
      const symlinkDir = path.join(tmpWs, "symlink-dir");
      fs.symlinkSync(outsideDir, symlinkDir, "dir");
      const pathUnderSymlinkDir = path.join(symlinkDir, "non-existent-sub");

      const prevWs = process.env.WORKSPACE_ROOT;
      process.env.WORKSPACE_ROOT = tmpWs;

      try {
        // Dangling symlink pointing outside
        assert.throws(
          () => resolveRepoPath(danglingLink, { allowNonExistent: true }),
          (err: any) =>
            err.code === "PATH_FORBIDDEN" &&
            err.status === 403 &&
            err.message.includes("Path or symlink target is outside workspace root")
        );

        // Path whose existing ancestor resolves outside workspace
        assert.throws(
          () => resolveRepoPath(pathUnderSymlinkDir, { allowNonExistent: true }),
          (err: any) =>
            err.code === "PATH_FORBIDDEN" &&
            err.status === 403 &&
            err.message.includes("Path or symlink target is outside workspace root")
        );
      } finally {
        if (prevWs !== undefined) {
          process.env.WORKSPACE_ROOT = prevWs;
        } else {
          delete process.env.WORKSPACE_ROOT;
        }
        fs.rmSync(tmpWs, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe("ensureReposConfigFile", () => {
    it("returns targetPath directly if configuration file already exists", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "util-repos-exists-"));
      const configPath = path.join(tmpDir, "repos.json");
      fs.writeFileSync(configPath, JSON.stringify([{ path: "/test" }]));
      try {
        const result = ensureReposConfigFile({ configPath });
        assert.equal(result, configPath);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("auto-generates repos.json when config file does not exist and workspace contains git repos", () => {
      const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "util-repos-ws-"));
      const repoCode = path.join(tmpWs, "order-service");
      const repoSystem = path.join(tmpWs, "system-knowledge");
      const hiddenDir = path.join(tmpWs, ".hidden-repo");
      const nonGitDir = path.join(tmpWs, "not-a-repo");

      fs.mkdirSync(path.join(repoCode, ".git"), { recursive: true });
      fs.mkdirSync(path.join(repoSystem, ".git"), { recursive: true });
      fs.mkdirSync(path.join(hiddenDir, ".git"), { recursive: true });
      fs.mkdirSync(nonGitDir, { recursive: true });

      const targetConfig = path.join(tmpWs, "config", "repos.json");

      try {
        const loggedInfo: any[] = [];
        const result = ensureReposConfigFile({
          configPath: targetConfig,
          workspaceRoot: tmpWs,
          log: {
            info: (msg, meta) => loggedInfo.push({ msg, meta }),
            warn: () => {},
            error: () => {},
          },
        });

        assert.equal(result, targetConfig);
        assert.equal(fs.existsSync(targetConfig), true);

        const content = JSON.parse(fs.readFileSync(targetConfig, "utf8"));
        assert.equal(Array.isArray(content), true);
        assert.equal(content.length, 2);

        // repoCode
        assert.equal(content[0].path, repoCode);
        assert.equal(content[0].repoType, "code");
        assert.equal(content[0].sourceBranch, "release");
        assert.equal(content[0].knowledgeBranch, "docs");

        // repoSystem
        assert.equal(content[1].path, repoSystem);
        assert.equal(content[1].repoType, "system_knowledge");
        assert.equal(content[1].sourceBranch, "master");
        assert.equal(content[1].knowledgeBranch, undefined);

        assert.equal(loggedInfo.length, 1);
        assert.equal(loggedInfo[0].meta.count, 2);
      } finally {
        fs.rmSync(tmpWs, { recursive: true, force: true });
      }
    });

    it("recognizes knowledge-system directory as system_knowledge repository", () => {
      const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "util-repos-ks-"));
      const repoKs = path.join(tmpWs, "knowledge-system");
      fs.mkdirSync(path.join(repoKs, ".git"), { recursive: true });
      const targetConfig = path.join(tmpWs, "repos.json");

      try {
        const result = ensureReposConfigFile({
          configPath: targetConfig,
          workspaceRoot: tmpWs,
        });

        assert.equal(result, targetConfig);
        const content = JSON.parse(fs.readFileSync(targetConfig, "utf8"));
        assert.equal(content.length, 1);
        assert.equal(content[0].path, repoKs);
        assert.equal(content[0].repoType, "system_knowledge");
        assert.equal(content[0].sourceBranch, "master");
      } finally {
        fs.rmSync(tmpWs, { recursive: true, force: true });
      }
    });

    it("returns undefined if workspace root contains no git repositories", () => {
      const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "util-repos-empty-"));
      fs.mkdirSync(path.join(tmpWs, "not-git"));
      const targetConfig = path.join(tmpWs, "repos.json");

      try {
        const result = ensureReposConfigFile({
          configPath: targetConfig,
          workspaceRoot: tmpWs,
        });
        assert.equal(result, undefined);
        assert.equal(fs.existsSync(targetConfig), false);
      } finally {
        fs.rmSync(tmpWs, { recursive: true, force: true });
      }
    });

    it("returns undefined if workspace root does not exist", () => {
      const nonExistentWs = path.join(os.tmpdir(), `non-existent-ws-${Date.now()}`);
      const targetConfig = path.join(os.tmpdir(), `target-${Date.now()}.json`);
      const result = ensureReposConfigFile({
        configPath: targetConfig,
        workspaceRoot: nonExistentWs,
      });
      assert.equal(result, undefined);
      assert.equal(fs.existsSync(targetConfig), false);
    });

    it("gracefully catches write errors and returns undefined with warning", () => {
      const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "util-repos-unwritable-"));
      const repo = path.join(tmpWs, "service-a");
      fs.mkdirSync(path.join(repo, ".git"), { recursive: true });

      // Use a targetPath that cannot be created as a directory (parent is a regular file)
      const regularFile = path.join(tmpWs, "file-blocker.txt");
      fs.writeFileSync(regularFile, "blocking file");
      const impossibleConfigPath = path.join(regularFile, "sub", "repos.json");

      const loggedWarn: any[] = [];
      try {
        const result = ensureReposConfigFile({
          configPath: impossibleConfigPath,
          workspaceRoot: tmpWs,
          log: {
            info: () => {},
            warn: (msg, meta) => loggedWarn.push({ msg, meta }),
            error: () => {},
          },
        });

        assert.equal(result, undefined);
        assert.equal(loggedWarn.length, 1);
        assert.ok(loggedWarn[0].meta.error);
      } finally {
        fs.rmSync(tmpWs, { recursive: true, force: true });
      }
    });
  });
});
