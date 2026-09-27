import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTestRuntime } from "@actiondock/testing";
import filesListAction from "../actions/files-list.ts";

describe("workspace/files.list", () => {
  it("lists directories and files with directory-first sorting", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-list-"));
    try {
      fs.mkdirSync(path.join(tmpDir, "b-dir"));
      fs.mkdirSync(path.join(tmpDir, "a-dir"));
      fs.writeFileSync(path.join(tmpDir, "z-file.txt"), "hello");
      fs.writeFileSync(path.join(tmpDir, "a-file.txt"), "world");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const res = await runtime.run(filesListAction, {});

      assert.equal(res.truncated, false);
      const paths = res.items.map((i) => i.path);
      // Directories first (a-dir, b-dir), then files (a-file.txt, z-file.txt)
      assert.deepEqual(paths, ["a-dir", "b-dir", "a-file.txt", "z-file.txt"]);
      assert.equal(res.items[0].type, "directory");
      assert.equal(res.items[2].type, "file");
      assert.equal(res.items[2].sizeBytes, 5);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("filters sensitive files and directories even if hidden is true", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-list-"));
    try {
      fs.mkdirSync(path.join(tmpDir, ".git"));
      fs.writeFileSync(path.join(tmpDir, ".git", "config"), "git-config");
      fs.writeFileSync(path.join(tmpDir, ".env"), "SECRET=true");
      fs.writeFileSync(path.join(tmpDir, ".env.example"), "PUBLIC=example");
      fs.writeFileSync(path.join(tmpDir, "normal.txt"), "ok");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const res = await runtime.run(filesListAction, { hidden: true });
      const paths = res.items.map((i) => i.path);

      // .git and .env must be excluded, .env.example and normal.txt must be included
      assert.ok(!paths.includes(".git"));
      assert.ok(!paths.includes(".env"));
      assert.ok(paths.includes(".env.example"));
      assert.ok(paths.includes("normal.txt"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("respects depth parameter", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-list-"));
    try {
      fs.mkdirSync(path.join(tmpDir, "sub"));
      fs.writeFileSync(path.join(tmpDir, "sub", "deep.txt"), "deep");
      fs.writeFileSync(path.join(tmpDir, "top.txt"), "top");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      // Depth 1: should not include sub/deep.txt
      const d1 = await runtime.run(filesListAction, { depth: 1 });
      const d1Paths = d1.items.map((i) => i.path);
      assert.deepEqual(d1Paths, ["sub", "top.txt"]);

      // Depth 2: should include sub/deep.txt
      const d2 = await runtime.run(filesListAction, { depth: 2 });
      const d2Paths = d2.items.map((i) => i.path);
      assert.ok(d2Paths.includes("sub/deep.txt"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
