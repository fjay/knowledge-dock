import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTestRuntime } from "@actiondock/testing";
import filesWriteAction from "../actions/files-write.ts";

describe("workspace/files.write", () => {
  it("creates a new file successfully with UTF-8 content", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-write-"));
    try {
      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const content = "你好，世界！\nHello, world!\n";
      const res = await runtime.run(filesWriteAction, {
        path: "hello.txt",
        content,
      });

      assert.equal(res.path, "hello.txt");
      assert.equal(res.created, true);
      assert.equal(res.bytesWritten, Buffer.byteLength(content, "utf8"));

      const saved = fs.readFileSync(path.join(tmpDir, "hello.txt"), "utf8");
      assert.equal(saved, content);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("overwrites existing file when overwrite is true (default)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-write-"));
    try {
      const file = path.join(tmpDir, "existing.txt");
      fs.writeFileSync(file, "old content");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const newContent = "updated content";
      const res = await runtime.run(filesWriteAction, {
        path: "existing.txt",
        content: newContent,
      });

      assert.equal(res.path, "existing.txt");
      assert.equal(res.created, false);
      assert.equal(res.bytesWritten, Buffer.byteLength(newContent, "utf8"));
      assert.equal(fs.readFileSync(file, "utf8"), newContent);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects write when overwrite is false and file exists", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-write-"));
    try {
      const file = path.join(tmpDir, "protected.txt");
      fs.writeFileSync(file, "original content");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () =>
          runtime.run(filesWriteAction, {
            path: "protected.txt",
            content: "attempted rewrite",
            overwrite: false,
          }),
        (err: any) => err.code === "FILE_ALREADY_EXISTS"
      );

      // Verify original file was not modified
      assert.equal(fs.readFileSync(file, "utf8"), "original content");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates missing parent directories when createDirs is true (default)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-write-"));
    try {
      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const deepPath = "sub/level1/level2/deep.txt";
      const res = await runtime.run(filesWriteAction, {
        path: deepPath,
        content: "deep content",
      });

      assert.equal(res.path, deepPath);
      assert.equal(res.created, true);
      assert.ok(fs.existsSync(path.join(tmpDir, deepPath)));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects write when createDirs is false and parent directory does not exist", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-write-"));
    try {
      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () =>
          runtime.run(filesWriteAction, {
            path: "nonexistent/dir/file.txt",
            content: "test",
            createDirs: false,
          }),
        (err: any) => err.code === "DIRECTORY_NOT_FOUND"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects write when path is already an existing directory", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-write-"));
    try {
      fs.mkdirSync(path.join(tmpDir, "somedir"));

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () =>
          runtime.run(filesWriteAction, {
            path: "somedir",
            content: "not allowed",
          }),
        (err: any) => err.code === "PATH_IS_DIRECTORY"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects write when parent path is an existing file", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-write-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "file-parent"), "i am a file");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () =>
          runtime.run(filesWriteAction, {
            path: "file-parent/child.txt",
            content: "test",
          }),
        (err: any) => err.code === "PARENT_NOT_DIRECTORY"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects sensitive paths like .env or .git files", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-write-"));
    try {
      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () => runtime.run(filesWriteAction, { path: ".env", content: "SECRET=1" }),
        (err: any) => err.code === "SENSITIVE_PATH_DENIED"
      );

      await assert.rejects(
        () => runtime.run(filesWriteAction, { path: "config/.git/HEAD", content: "ref" }),
        (err: any) => err.code === "SENSITIVE_PATH_DENIED"
      );

      await assert.rejects(
        () => runtime.run(filesWriteAction, { path: "id_rsa", content: "key" }),
        (err: any) => err.code === "SENSITIVE_PATH_DENIED"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects path traversal outside workspace root", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-write-"));
    try {
      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () =>
          runtime.run(filesWriteAction, {
            path: "../escape.txt",
            content: "escaped",
          }),
        (err: any) => err.code === "PATH_OUTSIDE_WORKSPACE"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects writing through symlink pointing outside workspace root", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-write-root-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-write-out-"));
    try {
      fs.symlinkSync(outsideDir, path.join(tmpDir, "symlink-dir"));

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () =>
          runtime.run(filesWriteAction, {
            path: "symlink-dir/leak.txt",
            content: "leak",
          }),
        (err: any) => err.code === "SYMLINK_OUTSIDE_WORKSPACE"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects empty or whitespace path", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-write-"));
    try {
      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () => runtime.run(filesWriteAction, { path: "", content: "test" }),
        (err: any) => err.code === "INVALID_ARGUMENT"
      );

      await assert.rejects(
        () => runtime.run(filesWriteAction, { path: "   ", content: "test" }),
        (err: any) => err.code === "INVALID_ARGUMENT"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles abort signal properly", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-write-"));
    try {
      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const controller = new AbortController();
      controller.abort();

      const res = await runtime.execute(
        filesWriteAction,
        { path: "aborted.txt", content: "hello" },
        { signal: controller.signal }
      );

      assert.equal(res.ok, false);
      assert.match(res.error?.message || "", /cancelled|aborted/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
