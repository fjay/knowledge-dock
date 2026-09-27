import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTestRuntime } from "@actiondock/testing";
import filesEditAction from "../actions/files-edit.ts";

describe("workspace/files.edit", () => {
  it("replaces a single target occurrence successfully", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-edit-"));
    try {
      const filePath = path.join(tmpDir, "sample.txt");
      fs.writeFileSync(filePath, "const a = 1;\nconst b = 2;\n", "utf8");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const res = await runtime.run(filesEditAction, {
        path: "sample.txt",
        targetContent: "const b = 2;",
        replacementContent: "const b = 200;",
      });

      assert.equal(res.path, "sample.txt");
      assert.equal(res.replacementsCount, 1);
      assert.equal(
        res.bytesWritten,
        Buffer.byteLength("const a = 1;\nconst b = 200;\n", "utf8")
      );
      assert.equal(
        fs.readFileSync(filePath, "utf8"),
        "const a = 1;\nconst b = 200;\n"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("treats replacement content literally without $ pattern expansion", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-edit-"));
    try {
      const filePath = path.join(tmpDir, "shell.txt");
      fs.writeFileSync(filePath, "echo old\n", "utf8");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      // $&、$`、$' 在字符串替换形式中会被特殊展开，函数形式必须原样写入
      await runtime.run(filesEditAction, {
        path: "shell.txt",
        targetContent: "old",
        replacementContent: "$&$`$'new",
      });

      assert.equal(fs.readFileSync(filePath, "utf8"), "echo $&$`$'new\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects multiple occurrences when allowMultiple is false (default)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-edit-"));
    try {
      const filePath = path.join(tmpDir, "dup.txt");
      fs.writeFileSync(filePath, "hello\nhello\n", "utf8");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () =>
          runtime.run(filesEditAction, {
            path: "dup.txt",
            targetContent: "hello",
            replacementContent: "hi",
          }),
        (err: any) => err.code === "AMBIGUOUS_REPLACEMENT"
      );

      // Verify file was untouched
      assert.equal(fs.readFileSync(filePath, "utf8"), "hello\nhello\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("replaces multiple occurrences when allowMultiple is true", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-edit-"));
    try {
      const filePath = path.join(tmpDir, "mult.txt");
      fs.writeFileSync(filePath, "foo bar foo baz foo\n", "utf8");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const res = await runtime.run(filesEditAction, {
        path: "mult.txt",
        targetContent: "foo",
        replacementContent: "qux",
        allowMultiple: true,
      });

      assert.equal(res.replacementsCount, 3);
      assert.equal(
        fs.readFileSync(filePath, "utf8"),
        "qux bar qux baz qux\n"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("constrains replacement within specified startLine and endLine range", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-edit-"));
    try {
      const filePath = path.join(tmpDir, "lines.txt");
      // Lines:
      // 1: item = duplicate
      // 2: target section start
      // 3: item = duplicate
      // 4: target section end
      // 5: item = duplicate
      const content = [
        "item = duplicate",
        "target section start",
        "item = duplicate",
        "target section end",
        "item = duplicate",
      ].join("\n") + "\n";
      fs.writeFileSync(filePath, content, "utf8");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      // Target lines 2 to 4: only one "item = duplicate" exists in lines 2..4
      const res = await runtime.run(filesEditAction, {
        path: "lines.txt",
        targetContent: "item = duplicate",
        replacementContent: "item = replaced",
        startLine: 2,
        endLine: 4,
      });

      assert.equal(res.replacementsCount, 1);

      const updated = fs.readFileSync(filePath, "utf8");
      const expected = [
        "item = duplicate",
        "target section start",
        "item = replaced",
        "target section end",
        "item = duplicate",
      ].join("\n") + "\n";

      assert.equal(updated, expected);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("respects startLine only and endLine only boundaries", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-edit-"));
    try {
      const filePath = path.join(tmpDir, "bounds.txt");
      fs.writeFileSync(filePath, "line 1\nline 2\nline 3\nline 4\n", "utf8");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      // startLine only (line 3 to end of file)
      await runtime.run(filesEditAction, {
        path: "bounds.txt",
        targetContent: "line 4",
        replacementContent: "line FOUR",
        startLine: 3,
      });

      // endLine only (start of file to line 2)
      await runtime.run(filesEditAction, {
        path: "bounds.txt",
        targetContent: "line 1",
        replacementContent: "line ONE",
        endLine: 2,
      });

      assert.equal(
        fs.readFileSync(filePath, "utf8"),
        "line ONE\nline 2\nline 3\nline FOUR\n"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws TARGET_NOT_FOUND when target is outside line range", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-edit-"));
    try {
      const filePath = path.join(tmpDir, "outside-range.txt");
      fs.writeFileSync(filePath, "L1\nL2\nL3\nL4\n", "utf8");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () =>
          runtime.run(filesEditAction, {
            path: "outside-range.txt",
            targetContent: "L1",
            replacementContent: "L1_MODIFIED",
            startLine: 2,
            endLine: 4,
          }),
        (err: any) => err.code === "TARGET_NOT_FOUND"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws TARGET_NOT_FOUND when targetContent does not exist in file", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-edit-"));
    try {
      const filePath = path.join(tmpDir, "missing.txt");
      fs.writeFileSync(filePath, "some text\n", "utf8");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () =>
          runtime.run(filesEditAction, {
            path: "missing.txt",
            targetContent: "nonexistent",
            replacementContent: "replacement",
          }),
        (err: any) => err.code === "TARGET_NOT_FOUND"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("validates line range boundaries and throws INVALID_LINE_RANGE", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-edit-"));
    try {
      const filePath = path.join(tmpDir, "test.txt");
      fs.writeFileSync(filePath, "line 1\nline 2\n", "utf8");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      // startLine < 1
      await assert.rejects(
        () =>
          runtime.run(filesEditAction, {
            path: "test.txt",
            targetContent: "line 1",
            replacementContent: "x",
            startLine: 0,
          }),
        (err: any) => err.code === "INVALID_LINE_RANGE"
      );

      // endLine < 1
      await assert.rejects(
        () =>
          runtime.run(filesEditAction, {
            path: "test.txt",
            targetContent: "line 1",
            replacementContent: "x",
            endLine: 0,
          }),
        (err: any) => err.code === "INVALID_LINE_RANGE"
      );

      // startLine > endLine
      await assert.rejects(
        () =>
          runtime.run(filesEditAction, {
            path: "test.txt",
            targetContent: "line 1",
            replacementContent: "x",
            startLine: 2,
            endLine: 1,
          }),
        (err: any) => err.code === "INVALID_LINE_RANGE"
      );

      // startLine > lines.length
      await assert.rejects(
        () =>
          runtime.run(filesEditAction, {
            path: "test.txt",
            targetContent: "line 1",
            replacementContent: "x",
            startLine: 10,
          }),
        (err: any) => err.code === "INVALID_LINE_RANGE"
      );

      // endLine > lines.length
      await assert.rejects(
        () =>
          runtime.run(filesEditAction, {
            path: "test.txt",
            targetContent: "line 1",
            replacementContent: "x",
            endLine: 10,
          }),
        (err: any) => err.code === "INVALID_LINE_RANGE"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects non-existent file with FILE_NOT_FOUND", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-edit-"));
    try {
      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () =>
          runtime.run(filesEditAction, {
            path: "does-not-exist.txt",
            targetContent: "a",
            replacementContent: "b",
          }),
        (err: any) => err.code === "FILE_NOT_FOUND"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects directory target with NOT_A_FILE", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-edit-"));
    try {
      fs.mkdirSync(path.join(tmpDir, "sub-directory"));

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () =>
          runtime.run(filesEditAction, {
            path: "sub-directory",
            targetContent: "a",
            replacementContent: "b",
          }),
        (err: any) => err.code === "NOT_A_FILE"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects sensitive files like .env", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-edit-"));
    try {
      fs.writeFileSync(path.join(tmpDir, ".env"), "KEY=secret\n");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () =>
          runtime.run(filesEditAction, {
            path: ".env",
            targetContent: "secret",
            replacementContent: "new",
          }),
        (err: any) => err.code === "SENSITIVE_PATH_DENIED"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects path outside workspace root", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-edit-"));
    try {
      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () =>
          runtime.run(filesEditAction, {
            path: "../outside.txt",
            targetContent: "a",
            replacementContent: "b",
          }),
        (err: any) => err.code === "PATH_OUTSIDE_WORKSPACE"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects binary files with UNSUPPORTED_BINARY_FILE", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-edit-"));
    try {
      const binFile = path.join(tmpDir, "binary.bin");
      fs.writeFileSync(binFile, Buffer.from([0x00, 0x01, 0x02, 0x03]));

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () =>
          runtime.run(filesEditAction, {
            path: "binary.bin",
            targetContent: "a",
            replacementContent: "b",
          }),
        (err: any) => err.code === "UNSUPPORTED_BINARY_FILE"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects non-UTF-8 text encoding with UNSUPPORTED_TEXT_ENCODING", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-edit-"));
    try {
      const badFile = path.join(tmpDir, "bad.txt");
      fs.writeFileSync(badFile, Buffer.from([0xc0, 0xaf, 0xfe, 0xff]));

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () =>
          runtime.run(filesEditAction, {
            path: "bad.txt",
            targetContent: "a",
            replacementContent: "b",
          }),
        (err: any) => err.code === "UNSUPPORTED_TEXT_ENCODING"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects empty targetContent or empty path", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-edit-"));
    try {
      const filePath = path.join(tmpDir, "file.txt");
      fs.writeFileSync(filePath, "hello");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () =>
          runtime.run(filesEditAction, {
            path: "file.txt",
            targetContent: "",
            replacementContent: "x",
          }),
        (err: any) => err.code === "INVALID_ARGUMENT"
      );

      await assert.rejects(
        () =>
          runtime.run(filesEditAction, {
            path: "",
            targetContent: "hello",
            replacementContent: "x",
          }),
        (err: any) => err.code === "INVALID_ARGUMENT"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles abort signal properly", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-edit-"));
    try {
      const filePath = path.join(tmpDir, "abort.txt");
      fs.writeFileSync(filePath, "hello world");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const controller = new AbortController();
      controller.abort();

      const res = await runtime.execute(
        filesEditAction,
        {
          path: "abort.txt",
          targetContent: "hello",
          replacementContent: "hi",
        },
        { signal: controller.signal }
      );

      assert.equal(res.ok, false);
      assert.match(res.error?.message || "", /cancelled|aborted/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
