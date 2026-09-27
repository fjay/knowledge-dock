import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRgArgs } from "../src/rg-args.ts";
import { MAX_MATCH_LINE_BYTES } from "../src/limits.ts";

describe("buildRgArgs parameter builder", () => {
  it("enforces mandatory flags and places pattern after '--'", () => {
    const args = buildRgArgs({ pattern: "test-query" }, ["src"]);

    assert.ok(args.includes("--no-config"));
    assert.ok(args.includes("--json"));

    const separatorIndex = args.indexOf("--");
    assert.ok(separatorIndex !== -1, "Must contain '--' separator");
    assert.equal(args[separatorIndex + 1], "test-query", "Pattern must directly follow '--'");
    assert.equal(args[separatorIndex + 2], "src", "Path must follow pattern");
  });

  it("ensures all default ignore globs are negative to avoid restricting search scope", () => {
    const args = buildRgArgs({ pattern: "test" }, []);

    // Extract all values following '-g'
    const globs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-g" && args[i + 1]) {
        globs.push(args[i + 1]);
      }
    }

    assert.ok(globs.length > 0, "Must have default ignore globs");
    for (const g of globs) {
      assert.ok(
        g.startsWith("!"),
        `Default glob '${g}' must be negative (start with '!') to avoid restricting ripgrep matching`
      );
    }
  });

  it("caps maxColumns to MAX_MATCH_LINE_BYTES server hard limit", () => {
    const defaultArgs = buildRgArgs({ pattern: "test" });
    const maxColIdx = defaultArgs.indexOf("--max-columns");
    assert.equal(defaultArgs[maxColIdx + 1], String(MAX_MATCH_LINE_BYTES));

    // When user asks for smaller columns, accept smaller
    const smallerArgs = buildRgArgs({ pattern: "test", maxColumns: 100 });
    const smallIdx = smallerArgs.indexOf("--max-columns");
    assert.equal(smallerArgs[smallIdx + 1], "100");

    // When user asks for larger columns exceeding server limit, cap to server limit
    const largerArgs = buildRgArgs({ pattern: "test", maxColumns: 999999 });
    const largeIdx = largerArgs.indexOf("--max-columns");
    assert.equal(largerArgs[largeIdx + 1], String(MAX_MATCH_LINE_BYTES));
  });

  it("maps ripgrep flags accurately according to input", () => {
    const args = buildRgArgs({
      pattern: "hello",
      fixedStrings: true,
      ignoreCase: true,
      smartCase: true,
      wordRegexp: true,
      lineRegexp: true,
      hidden: true,
      noIgnore: true,
      follow: true,
      context: 3,
      maxCount: 10,
      type: ["ts", "json"],
      typeNot: ["md"],
      glob: ["*.test.ts"],
    });

    assert.ok(args.includes("--fixed-strings"));
    assert.ok(args.includes("--ignore-case"));
    assert.ok(args.includes("--smart-case"));
    assert.ok(args.includes("--word-regexp"));
    assert.ok(args.includes("--line-regexp"));
    assert.ok(args.includes("--hidden"));
    assert.ok(args.includes("--no-ignore"));
    assert.ok(args.includes("--follow"));
    assert.ok(args.includes("-C"));
    assert.ok(args.includes("--max-count"));
    assert.ok(args.includes("--type"));
    assert.ok(args.includes("--type-not"));
    assert.ok(args.includes("*.test.ts"));
  });
});
