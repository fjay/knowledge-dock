import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTestRuntime, createTestPlatform, FakeProcessDriver } from "@actiondock/testing";
import filesReadAction from "../actions/files-read.ts";
import filesListAction from "../actions/files-list.ts";
import searchRgAction from "../actions/search-rg.ts";
import { WorkspacePathPolicy } from "../src/path-policy.ts";
import { buildRgArgs } from "../src/rg-args.ts";
import { RgJsonStreamParser } from "../src/rg-json-parser.ts";
import { MAX_SEARCH_OUTPUT_BYTES } from "../src/limits.ts";

describe("Coverage edge cases", () => {
  it("covers path-policy error cases and options", () => {
    // Non-existent root
    assert.throws(
      () => new WorkspacePathPolicy("/path/that/does/not/exist/99999"),
      (err: any) => err.code === "WORKSPACE_ROOT_NOT_FOUND"
    );

    // Default constructor with no args (falls back to process.cwd())
    const defaultPolicy = new WorkspacePathPolicy();
    assert.ok(defaultPolicy.root.length > 0);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-cov-"));
    try {
      const policy = new WorkspacePathPolicy(tmpDir);

      // allowNonExistent
      const nonExistent = policy.resolveAndValidate("future/file.txt", { allowNonExistent: true });
      assert.equal(nonExistent.relativePath, "future/file.txt");

      // Symlink to sensitive path inside workspace
      fs.writeFileSync(path.join(tmpDir, ".env"), "SECRET=1");
      fs.symlinkSync(path.join(tmpDir, ".env"), path.join(tmpDir, "sym-env"));
      assert.throws(
        () => policy.resolveAndValidate("sym-env"),
        (err: any) => err.code === "SENSITIVE_PATH_DENIED"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("covers files.read edge cases (not a file, non-UTF8, byte limit, abort)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-cov-"));
    try {
      const runtime = createTestRuntime({ config: { WORKSPACE_ROOT: tmpDir } });

      // Reading a directory instead of file
      fs.mkdirSync(path.join(tmpDir, "some-dir"));
      await assert.rejects(
        () => runtime.run(filesReadAction, { path: "some-dir" }),
        (err: any) => err.code === "NOT_A_FILE"
      );

      // Non-UTF8 encoding (invalid sequence)
      const invalidUtf8 = Buffer.from([0xc0, 0xaf, 0xfe, 0xff]);
      fs.writeFileSync(path.join(tmpDir, "bad-utf8.txt"), invalidUtf8);
      await assert.rejects(
        () => runtime.run(filesReadAction, { path: "bad-utf8.txt" }),
        (err: any) => err.code === "UNSUPPORTED_TEXT_ENCODING"
      );

      // Byte limit truncation (300 lines of 4000 bytes = 1.2MB > MAX_READ_BYTES 1MB)
      const largeLine = "A".repeat(4000);
      const largeFile = path.join(tmpDir, "large.txt");
      fs.writeFileSync(largeFile, Array(300).fill(largeLine).join("\n"));
      const readRes = await runtime.run(filesReadAction, { path: "large.txt", maxLines: 500 });
      assert.equal(readRes.truncated, true);

      // In-flight abort signal during line iteration
      const controller = new AbortController();
      const inFlightFile = path.join(tmpDir, "inflight.txt");
      fs.writeFileSync(inFlightFile, Array(50000).fill("line-item").join("\n"));
      setTimeout(() => controller.abort(), 1);
      const res = await runtime.execute(filesReadAction, { path: "inflight.txt", maxLines: 1000 }, { signal: controller.signal });
      assert.equal(res.ok, false);
      assert.match(res.error?.message || "", /cancelled|aborted/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("covers files.list edge cases (not a directory, symlinks, abort)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-cov-"));
    try {
      const runtime = createTestRuntime({ config: { WORKSPACE_ROOT: tmpDir } });

      // Listing a file instead of directory
      fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello");
      await assert.rejects(
        () => runtime.run(filesListAction, { path: "file.txt" }),
        (err: any) => err.code === "NOT_A_DIRECTORY"
      );

      // Symlinks to directory and file
      fs.mkdirSync(path.join(tmpDir, "real-dir"));
      fs.symlinkSync(path.join(tmpDir, "real-dir"), path.join(tmpDir, "sym-dir"));
      fs.symlinkSync(path.join(tmpDir, "file.txt"), path.join(tmpDir, "sym-file.txt"));
      const listRes = await runtime.run(filesListAction, {});
      const paths = listRes.items.map((i) => i.path);
      assert.ok(paths.includes("sym-dir"));
      assert.ok(paths.includes("sym-file.txt"));

      // Aborted signal
      const controller = new AbortController();
      controller.abort();
      const execRes = await runtime.execute(filesListAction, {}, { signal: controller.signal });
      assert.equal(execRes.ok, false);
      assert.match(execRes.error?.message || "", /cancelled|aborted/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("covers search.rg edge cases (paths filter, max results limit, output byte cap, error without stderr, abort)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-cov-"));
    try {
      // 1. Max results limit
      const fakeDriver = new FakeProcessDriver();
      fakeDriver.onSpawn = (handle: any) => {
        const events: string[] = [];
        for (let i = 1; i <= 250; i++) {
          events.push(
            JSON.stringify({
              type: "match",
              data: {
                path: { text: "src/many.ts" },
                lines: { text: `match line ${i}\n` },
                line_number: i,
              },
            })
          );
        }
        handle.emitOutput("stdout", events.join("\n") + "\n");
        handle.emitExit({ code: 0, signal: null });
        handle.emitOutputClosed("natural");
      };

      const platform = createTestPlatform({ processDriver: fakeDriver });
      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
        platform,
      });

      fs.mkdirSync(path.join(tmpDir, "src"));
      fs.writeFileSync(path.join(tmpDir, "src", "many.ts"), "dummy");

      const res = await runtime.run(searchRgAction, {
        pattern: "match",
        paths: ["src/many.ts"],
      });

      assert.equal(res.truncated, true);
      assert.equal(res.matches.length, 200);

      // 2. Output byte cap exceeded
      const bigOutputDriver = new FakeProcessDriver();
      bigOutputDriver.onSpawn = (handle: any) => {
        // Emit chunks exceeding MAX_SEARCH_OUTPUT_BYTES
        const bigChunk = "X".repeat(1024 * 1024); // 1MB chunk
        for (let i = 0; i < 5; i++) {
          handle.emitOutput("stderr", bigChunk);
        }
        handle.emitExit({ code: 0, signal: null });
        handle.emitOutputClosed("natural");
      };

      const bigRuntime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
        platform: createTestPlatform({ processDriver: bigOutputDriver }),
      });

      const bigRes = await bigRuntime.run(searchRgAction, { pattern: "test" });
      assert.equal(bigRes.truncated, true);

      // 3. Error without stderr output
      const silentErrorDriver = new FakeProcessDriver();
      silentErrorDriver.onSpawn = (handle: any) => {
        handle.emitExit({ code: 2, signal: null });
        handle.emitOutputClosed("natural");
      };
      const silentRuntime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
        platform: createTestPlatform({ processDriver: silentErrorDriver }),
      });
      await assert.rejects(
        () => silentRuntime.run(searchRgAction, { pattern: "test" }),
        /ripgrep exited with code 2/
      );

      // 4. In-flight abort
      const abortDriver = new FakeProcessDriver();
      const abortController = new AbortController();
      abortDriver.onSpawn = (handle: any) => {
        abortController.abort();
        handle.emitExit({ code: 0, signal: "SIGTERM" });
        handle.emitOutputClosed("natural");
      };
      const abortRuntime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
        platform: createTestPlatform({ processDriver: abortDriver }),
      });
      const abortRes = await abortRuntime.execute(
        searchRgAction,
        { pattern: "test" },
        { signal: abortController.signal }
      );
      assert.equal(abortRes.ok, false);
      assert.match(abortRes.error?.message || "", /cancelled|aborted/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("covers rg-args additional options and defaults", () => {
    const args = buildRgArgs({
      pattern: "test",
      maxColumnsPreview: true,
      beforeContext: 2,
      afterContext: 3,
      multiline: true,
      multilineDotall: true,
    });
    assert.ok(args.includes("--max-columns-preview"));
    assert.ok(args.includes("-B"));
    assert.ok(args.includes("-A"));
    assert.ok(args.includes("--multiline"));
    assert.ok(args.includes("--multiline-dotall"));

    // rg-json-parser default constructor
    const policy = new WorkspacePathPolicy();
    const parser = new RgJsonStreamParser({ pathPolicy: policy });
    assert.ok(parser);
  });
});
