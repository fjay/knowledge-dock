import { MAX_MATCH_LINE_BYTES } from "./limits.ts";
import { getRipgrepIgnoreGlobs } from "./file-policy.ts";
import type { ActionInput } from "../.actiondock/generated/actions.d.ts";

export type SearchRgInput = ActionInput<"search.rg">;

/**
 * Builds the ripgrep CLI argument list strictly following ripgrep semantics.
 * Mandates --no-config, --json, server limits, and puts pattern after '--'.
 */
export function buildRgArgs(
  input: SearchRgInput,
  resolvedRelativePaths: string[] = []
): string[] {
  const args: string[] = [];

  // Mandatory internal flags (Section 10)
  args.push("--no-config");
  args.push("--json");

  // Max columns enforcement (Section 19)
  const effectiveMaxColumns =
    input.maxColumns !== undefined
      ? Math.min(input.maxColumns, MAX_MATCH_LINE_BYTES)
      : MAX_MATCH_LINE_BYTES;
  args.push("--max-columns", String(effectiveMaxColumns));

  if (input.maxColumnsPreview) {
    args.push("--max-columns-preview");
  }

  // Supported flags in predictable order (Section 33 & 34)
  if (input.fixedStrings) {
    args.push("--fixed-strings");
  }
  if (input.ignoreCase) {
    args.push("--ignore-case");
  }
  if (input.smartCase) {
    args.push("--smart-case");
  }
  if (input.wordRegexp) {
    args.push("--word-regexp");
  }
  if (input.lineRegexp) {
    args.push("--line-regexp");
  }

  if (input.hidden) {
    args.push("--hidden");
  }
  if (input.noIgnore) {
    args.push("--no-ignore");
  }
  if (input.follow) {
    args.push("--follow");
  }

  if (input.context !== undefined) {
    args.push("-C", String(input.context));
  }
  if (input.beforeContext !== undefined) {
    args.push("-B", String(input.beforeContext));
  }
  if (input.afterContext !== undefined) {
    args.push("-A", String(input.afterContext));
  }

  if (input.multiline) {
    args.push("--multiline");
  }
  if (input.multilineDotall) {
    args.push("--multiline-dotall");
  }

  if (input.maxCount !== undefined) {
    args.push("--max-count", String(input.maxCount));
  }

  if (input.type && Array.isArray(input.type)) {
    for (const t of input.type) {
      args.push("--type", t);
    }
  }

  if (input.typeNot && Array.isArray(input.typeNot)) {
    for (const tn of input.typeNot) {
      args.push("--type-not", tn);
    }
  }

  // Prepend sensitive file filter globs
  const ignoreGlobs = getRipgrepIgnoreGlobs();
  for (const ig of ignoreGlobs) {
    args.push("-g", ig);
  }

  // User globs (preserve order as per section 8.4)
  if (input.glob && Array.isArray(input.glob)) {
    for (const g of input.glob) {
      args.push("-g", g);
    }
  }

  // Pattern MUST follow '--' (Section 11)
  args.push("--");
  args.push(input.pattern);

  // Target paths (relative to workspace root)
  if (resolvedRelativePaths.length > 0) {
    for (const p of resolvedRelativePaths) {
      args.push(p === "" ? "." : p);
    }
  } else {
    args.push(".");
  }

  return args;
}
