import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTestRuntime, createTestPlatform, FakeProcessDriver } from "@actiondock/testing";
import searchRgAction from "../actions/search-rg.ts";

function createRuntimeWithDriver(tmpDir: string, fakeDriver: FakeProcessDriver) {
  const platform = createTestPlatform({ processDriver: fakeDriver });
  return createTestRuntime({
    config: { WORKSPACE_ROOT: tmpDir },
    platform,
  });
}

describe("workspace/search.rg", () => {
  it("parses ripgrep JSON output and maps matches with context", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-rg-"));
    try {
      const fakeDriver = new FakeProcessDriver();

      fakeDriver.onSpawn = (handle: any) => {
        const events = [
          JSON.stringify({ type: "begin", data: { path: { text: "src/index.ts" } } }),
          JSON.stringify({
            type: "context",
            data: {
              path: { text: "src/index.ts" },
              lines: { text: "// before line\n" },
              line_number: 9,
            },
          }),
          JSON.stringify({
            type: "match",
            data: {
              path: { text: "src/index.ts" },
              lines: { text: "export function refund_status() {}\n" },
              line_number: 10,
            },
          }),
          JSON.stringify({
            type: "context",
            data: {
              path: { text: "src/index.ts" },
              lines: { text: "// after line\n" },
              line_number: 11,
            },
          }),
          JSON.stringify({ type: "end", data: { path: { text: "src/index.ts" } } }),
          JSON.stringify({ type: "summary", data: {} }),
        ];

        handle.emitOutput("stdout", events.join("\n") + "\n");
        handle.emitExit({ code: 0, signal: null });
        handle.emitOutputClosed("natural");
      };

      const runtime = createRuntimeWithDriver(tmpDir, fakeDriver);

      const res = await runtime.run(searchRgAction, {
        pattern: "refund_status",
        context: 1,
      });

      assert.equal(res.truncated, false);
      assert.equal(res.matches.length, 1);
      const m = res.matches[0];
      assert.equal(m.path, "src/index.ts");
      assert.equal(m.line, 10);
      assert.equal(m.text, "export function refund_status() {}");
      assert.deepEqual(m.before, [{ line: 9, text: "// before line" }]);
      assert.deepEqual(m.after, [{ line: 11, text: "// after line" }]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles exit code 1 as successful search with 0 matches", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-rg-"));
    try {
      const fakeDriver = new FakeProcessDriver();

      fakeDriver.onSpawn = (handle: any) => {
        handle.emitExit({ code: 1, signal: null });
        handle.emitOutputClosed("natural");
      };

      const runtime = createRuntimeWithDriver(tmpDir, fakeDriver);

      const res = await runtime.run(searchRgAction, {
        pattern: "non_existent_pattern",
      });

      assert.equal(res.truncated, false);
      assert.equal(res.matches.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws SEARCH_FAILED when ripgrep exits with error code 2", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-rg-"));
    try {
      const fakeDriver = new FakeProcessDriver();

      fakeDriver.onSpawn = (handle: any) => {
        handle.emitOutput("stderr", "error: regex parse error\n");
        handle.emitExit({ code: 2, signal: null });
        handle.emitOutputClosed("natural");
      };

      const runtime = createRuntimeWithDriver(tmpDir, fakeDriver);

      await assert.rejects(
        () => runtime.run(searchRgAction, { pattern: "(unclosed" }),
        (err: any) => err.code === "SEARCH_FAILED"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("filters sensitive file matches from results", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-rg-"));
    try {
      const fakeDriver = new FakeProcessDriver();

      fakeDriver.onSpawn = (handle: any) => {
        const events = [
          JSON.stringify({
            type: "match",
            data: {
              path: { text: ".env" },
              lines: { text: "SECRET=12345\n" },
              line_number: 1,
            },
          }),
          JSON.stringify({
            type: "match",
            data: {
              path: { text: "src/app.ts" },
              lines: { text: "const app = 1;\n" },
              line_number: 5,
            },
          }),
        ];

        handle.emitOutput("stdout", events.join("\n") + "\n");
        handle.emitExit({ code: 0, signal: null });
        handle.emitOutputClosed("natural");
      };

      const runtime = createRuntimeWithDriver(tmpDir, fakeDriver);

      const res = await runtime.run(searchRgAction, {
        pattern: "SECRET",
      });

      assert.equal(res.matches.length, 1);
      assert.equal(res.matches[0].path, "src/app.ts");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("truncates line when exceeding max-columns", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-rg-"));
    try {
      const fakeDriver = new FakeProcessDriver();

      fakeDriver.onSpawn = (handle: any) => {
        const events = [
          JSON.stringify({
            type: "match",
            data: {
              path: { text: "data.json" },
              lines: { text: "very_long_data_entry_that_exceeds_column_limit\n" },
              line_number: 1,
            },
          }),
        ];

        handle.emitOutput("stdout", events.join("\n") + "\n");
        handle.emitExit({ code: 0, signal: null });
        handle.emitOutputClosed("natural");
      };

      const runtime = createRuntimeWithDriver(tmpDir, fakeDriver);

      const res = await runtime.run(searchRgAction, {
        pattern: "very_long",
        maxColumns: 15,
      });

      assert.equal(res.matches.length, 1);
      assert.equal(res.matches[0].truncated, true);
      assert.equal(res.matches[0].text.length, 15);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("respects maxResults and truncates search when limit reached", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-rg-limit-"));
    try {
      const fakeDriver = new FakeProcessDriver();

      fakeDriver.onSpawn = (handle: any) => {
        const events = Array.from({ length: 10 }, (_, i) =>
          JSON.stringify({
            type: "match",
            data: {
              path: { text: `file_${i}.ts` },
              lines: { text: `match_${i}\n` },
              line_number: i + 1,
            },
          })
        );

        handle.emitOutput("stdout", events.join("\n") + "\n");
        handle.emitExit({ code: 0, signal: null });
        handle.emitOutputClosed("natural");
      };

      const runtime = createRuntimeWithDriver(tmpDir, fakeDriver);

      const res = await runtime.run(searchRgAction, {
        pattern: "match",
        maxResults: 3,
      });

      assert.equal(res.matches.length, 3);
      assert.equal(res.truncated, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
