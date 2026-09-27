import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

describe("workspace/search.rg end-to-end integration via ad CLI with real ripgrep", () => {
  it("executes real ripgrep process and returns actual matches on filesystem fixture", () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-e2e-"));
    try {
      const srcDir = path.join(tmpDir, "src");
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, "service.ts"), "export const payment = 1;\n");
      fs.writeFileSync(path.join(srcDir, "util.ts"), "export const PAYMENT_FEE = 2;\n");
      fs.writeFileSync(path.join(tmpDir, ".env"), "PAYMENT_KEY=secret\n");

      const stdout = execFileSync(
        "ad",
        [
          "run",
          "search.rg",
          "--json",
          "-c",
          `WORKSPACE_ROOT=${tmpDir}`,
          "--input",
          JSON.stringify({
            pattern: "payment|PAYMENT",
            ignoreCase: true,
          }),
        ],
        {
          cwd: projectRoot,
          encoding: "utf8",
        }
      );

      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.data.truncated, false);
      const matchedPaths = parsed.data.matches.map((m: any) => m.path).sort();
      assert.deepEqual(matchedPaths, ["src/service.ts", "src/util.ts"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("respects fixedStrings with real ripgrep", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-e2e-"));
    try {
      const file = path.join(tmpDir, "sample.ts");
      fs.writeFileSync(file, "const a = fn('hello.*');\nconst b = fn('hello');\n");

      const projectRoot = path.resolve(import.meta.dirname, "..");
      const stdout = execFileSync(
        "ad",
        [
          "run",
          "search.rg",
          "--json",
          "-c",
          `WORKSPACE_ROOT=${tmpDir}`,
          "--input",
          JSON.stringify({
            pattern: "hello.*",
            fixedStrings: true,
          }),
        ],
        {
          cwd: projectRoot,
          encoding: "utf8",
        }
      );

      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.data.matches.length, 1);
      assert.equal(parsed.data.matches[0].line, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("respects maxResults limit with real ripgrep", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-e2e-"));
    try {
      const file = path.join(tmpDir, "sample.ts");
      const lines = Array.from({ length: 50 }, (_, i) => `const val_${i} = 10000004;`);
      fs.writeFileSync(file, lines.join("\n"));

      const projectRoot = path.resolve(import.meta.dirname, "..");
      const stdout = execFileSync(
        "ad",
        [
          "run",
          "search.rg",
          "--json",
          "-c",
          `WORKSPACE_ROOT=${tmpDir}`,
          "--input",
          JSON.stringify({
            pattern: "10000004",
            maxResults: 20,
          }),
        ],
        {
          cwd: projectRoot,
          encoding: "utf8",
        }
      );

      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.data.matches.length, 20);
      assert.equal(parsed.data.truncated, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("executes with flat argument assignments (-- pattern=... paths.0=...)", () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-e2e-flat-"));
    try {
      const srcDir = path.join(tmpDir, "src");
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, "service.ts"), "export const payment = 1;\n");
      fs.writeFileSync(path.join(srcDir, "util.ts"), "export const PAYMENT_FEE = 2;\n");

      const stdout = execFileSync(
        "ad",
        [
          "run",
          "search.rg",
          "--json",
          "-c",
          `WORKSPACE_ROOT=${tmpDir}`,
          "--",
          "pattern=PAYMENT",
          "ignoreCase:=true",
          "paths.0=src",
        ],
        {
          cwd: projectRoot,
          encoding: "utf8",
        }
      );

      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.data.truncated, false);
      const matchedPaths = parsed.data.matches.map((m: any) => m.path).sort();
      assert.deepEqual(matchedPaths, ["src/service.ts", "src/util.ts"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("executes files.read and files.list with flat argument assignments", () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-e2e-flat-"));
    try {
      const srcDir = path.join(tmpDir, "src");
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, "hello.txt"), "line1\nline2\nline3\n");

      // Test files.list with flat args
      const listStdout = execFileSync(
        "ad",
        [
          "run",
          "files.list",
          "--json",
          "-c",
          `WORKSPACE_ROOT=${tmpDir}`,
          "--",
          "path=src",
          "depth:=1",
        ],
        {
          cwd: projectRoot,
          encoding: "utf8",
        }
      );
      const listParsed = JSON.parse(listStdout);
      assert.equal(listParsed.ok, true);
      assert.equal(listParsed.data.items.length, 1);
      assert.equal(listParsed.data.items[0].path, "src/hello.txt");

      // Test files.read with flat args
      const readStdout = execFileSync(
        "ad",
        [
          "run",
          "files.read",
          "--json",
          "-c",
          `WORKSPACE_ROOT=${tmpDir}`,
          "--",
          "path=src/hello.txt",
          "startLine:=2",
          "maxLines:=1",
        ],
        {
          cwd: projectRoot,
          encoding: "utf8",
        }
      );
      const readParsed = JSON.parse(readStdout);
      assert.equal(readParsed.ok, true);
      assert.equal(readParsed.data.startLine, 2);
      assert.equal(readParsed.data.endLine, 2);
      assert.equal(readParsed.data.content, "line2");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("executes files.write and files.edit with flat argument assignments via ad CLI", () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-e2e-edit-"));
    try {
      // Test files.write
      const writeStdout = execFileSync(
        "ad",
        [
          "run",
          "files.write",
          "--json",
          "-c",
          `WORKSPACE_ROOT=${tmpDir}`,
          "--",
          "path=docs/guide.txt",
          "content=line1\nline2\nline3\n",
        ],
        {
          cwd: projectRoot,
          encoding: "utf8",
        }
      );
      const writeParsed = JSON.parse(writeStdout);
      assert.equal(writeParsed.ok, true);
      assert.equal(writeParsed.data.path, "docs/guide.txt");
      assert.equal(writeParsed.data.created, true);

      // Test files.edit
      const editStdout = execFileSync(
        "ad",
        [
          "run",
          "files.edit",
          "--json",
          "-c",
          `WORKSPACE_ROOT=${tmpDir}`,
          "--",
          "path=docs/guide.txt",
          "targetContent=line2",
          "replacementContent=line2-updated",
        ],
        {
          cwd: projectRoot,
          encoding: "utf8",
        }
      );
      const editParsed = JSON.parse(editStdout);
      assert.equal(editParsed.ok, true);
      assert.equal(editParsed.data.replacementsCount, 1);

      const updated = fs.readFileSync(path.join(tmpDir, "docs/guide.txt"), "utf8");
      assert.equal(updated, "line1\nline2-updated\nline3\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects unknown parameters due to additionalProperties false", () => {

    const projectRoot = path.resolve(import.meta.dirname, "..");
    assert.throws(() => {
      execFileSync(
        "ad",
        [
          "run",
          "search.rg",
          "--input",
          JSON.stringify({
            pattern: "test",
            unknownField: 123,
          }),
        ],
        {
          cwd: projectRoot,
          encoding: "utf8",
          stdio: "pipe",
        }
      );
    });
  });
});

