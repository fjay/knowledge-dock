import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import {
  createTestRuntime,
  createTestPlatform,
  MockProcessExecutor,
} from "@actiondock/testing";
import bashExecAction from "../actions/bash-exec.ts";

function createRuntime(tmpDir: string) {
  const platform = createTestPlatform({
    process: new MockProcessExecutor({ fallbackToReal: true }),
  });
  return createTestRuntime({
    config: { WORKSPACE_ROOT: tmpDir },
    platform,
  });
}

describe("workspace/bash.exec", () => {
  it("executes a basic command and captures content", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-bash-"));
    try {
      const runtime = createRuntime(tmpDir);
      const res = await runtime.run(bashExecAction, {
        command: "echo 'hello from bash'",
      });

      assert.equal(res.exitCode, 0);
      assert.match(res.content, /hello from bash/);
      assert.equal(res.truncated, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles non-zero exit code and captures error content", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-bash-"));
    try {
      const runtime = createRuntime(tmpDir);
      const res = await runtime.run(bashExecAction, {
        command: "ls non_existent_file_random_xyz_123",
      });

      assert.notEqual(res.exitCode, 0);
      assert.match(res.content, /No such file or directory/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("respects custom cwd within workspace", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-bash-"));
    const subDir = path.join(tmpDir, "nested-sub");
    fs.mkdirSync(subDir);
    try {
      const runtime = createRuntime(tmpDir);
      const res = await runtime.run(bashExecAction, {
        command: "pwd",
        cwd: "nested-sub",
      });

      assert.equal(res.exitCode, 0);
      // Resolves to nested-sub directory
      assert.match(res.content, /nested-sub/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("executes git commands including restore, status, and diff seamlessly", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-bash-git-"));
    try {
      execSync(
        "git init && git config user.name test && git config user.email test@test.com",
        { cwd: tmpDir }
      );
      const filePath = path.join(tmpDir, "sample.txt");
      fs.writeFileSync(filePath, "original content\n");
      execSync("git add sample.txt && git commit -m 'Initial commit'", { cwd: tmpDir });

      // Modify the file
      fs.writeFileSync(filePath, "modified content\n");

      const runtime = createRuntime(tmpDir);

      // 1. git status
      const statusRes = await runtime.run(bashExecAction, {
        command: "git status --porcelain",
      });
      assert.equal(statusRes.exitCode, 0);
      assert.match(statusRes.content, /M sample\.txt/);

      // 2. git diff
      const diffRes = await runtime.run(bashExecAction, {
        command: "git diff",
      });
      assert.equal(diffRes.exitCode, 0);
      assert.match(diffRes.content, /modified content/);

      // 3. git restore
      const restoreRes = await runtime.run(bashExecAction, {
        command: "git restore .",
      });
      assert.equal(restoreRes.exitCode, 0);

      // Verify content restored
      const afterRestore = fs.readFileSync(filePath, "utf8");
      assert.equal(afterRestore, "original content\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects empty command with INVALID_ARGUMENT", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-bash-"));
    try {
      const runtime = createRuntime(tmpDir);
      await assert.rejects(
        () => runtime.run(bashExecAction, { command: "   " }),
        (err: any) => err.code === "INVALID_ARGUMENT"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects cwd escaping workspace root with PATH_OUTSIDE_WORKSPACE", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-bash-"));
    try {
      const runtime = createRuntime(tmpDir);
      await assert.rejects(
        () => runtime.run(bashExecAction, { command: "pwd", cwd: "../.." }),
        (err: any) => err.code === "PATH_OUTSIDE_WORKSPACE"
      );
      await assert.rejects(
        () => runtime.run(bashExecAction, { command: "pwd", cwd: "/etc" }),
        (err: any) => err.code === "PATH_OUTSIDE_WORKSPACE"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects non-directory cwd with NOT_A_DIRECTORY", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-bash-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "file.txt"), "x");
      const runtime = createRuntime(tmpDir);
      await assert.rejects(
        () => runtime.run(bashExecAction, { command: "pwd", cwd: "file.txt" }),
        (err: any) => err.code === "NOT_A_DIRECTORY"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("outputs unboxed raw content to stdout and exitCode to stderr via ad CLI", () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const res = execSync(
      `ad run bash.exec -c WORKSPACE_ROOT=${JSON.stringify(projectRoot)} -- command="echo 'raw terminal stream'"`,
      {
        cwd: projectRoot,
        encoding: "utf8",
      }
    );

    // stdout must contain the raw string with real newline, without JSON escaping
    assert.match(res, /raw terminal stream/);
    assert.ok(!res.includes("\"exitCode\""));
    assert.ok(!res.includes("\"content\""));
  });
});
