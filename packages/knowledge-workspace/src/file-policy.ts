/**
 * Sensitive File Policy implementation.
 * Ensures consistent sensitive file filtering across all workspace actions.
 */

import fs from "node:fs";
import { WorkspaceError, WorkspaceErrorCode } from "./errors.ts";

/**
 * Checks whether a given relative POSIX path matches sensitive file rules.
 * Paths are expected to use forward slashes and no leading slash.
 */
export function isSensitivePath(relativePath: string): boolean {
  if (!relativePath) {
    return false;
  }
  const cleanPath = relativePath.replace(/^(\.\/|\/)+/, "");
  const segments = cleanPath.split("/");
  const fileName = segments[segments.length - 1] || "";
  const lowerFileName = fileName.toLowerCase();

  // Whitelist .env.example and .env.template (exact match or anywhere in hierarchy)
  if (lowerFileName === ".env.example" || lowerFileName === ".env.template") {
    return false;
  }

  // Deny .git directory and any files inside .git
  if (segments.includes(".git")) {
    return true;
  }

  // Deny .env, .env.*
  if (lowerFileName === ".env" || lowerFileName.startsWith(".env.")) {
    return true;
  }

  // Deny *.pem, *.key
  if (lowerFileName.endsWith(".pem") || lowerFileName.endsWith(".key")) {
    return true;
  }

  // Deny id_rsa, id_rsa.*
  if (lowerFileName === "id_rsa" || lowerFileName.startsWith("id_rsa.")) {
    return true;
  }

  // Deny .npmrc, .pypirc
  if (lowerFileName === ".npmrc" || lowerFileName === ".pypirc") {
    return true;
  }

  return false;
}

/**
 * Common ripgrep ignore globs to exclude sensitive files directly at the search engine level.
 */
export function getRipgrepIgnoreGlobs(): string[] {
  return [
    "!.git",
    "!.git/**",
    "!**/.git/**",
    "!.env",
    "!**/.env",
    "!*.pem",
    "!**/*.pem",
    "!*.key",
    "!**/*.key",
    "!id_rsa",
    "!id_rsa.*",
    "!**/id_rsa",
    "!**/id_rsa.*",
    "!.npmrc",
    "!**/.npmrc",
    "!.pypirc",
    "!**/.pypirc",
  ];
}

/**
 * Validates that file is UTF-8 text and not binary.
 */
export function validateUtf8File(filePath: string, sizeBytes: number): void {
  if (sizeBytes === 0) {
    return;
  }
  const sampleSize = Math.min(sizeBytes, 8192);
  const buffer = Buffer.alloc(sampleSize);
  const fd = fs.openSync(filePath, "r");
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, sampleSize, 0);
    const slice = buffer.subarray(0, bytesRead);

    // Binary check: contains 0x00 null byte
    for (let i = 0; i < slice.length; i++) {
      if (slice[i] === 0) {
        throw new WorkspaceError(
          "Binary file is not supported",
          WorkspaceErrorCode.UNSUPPORTED_BINARY_FILE,
          415
        );
      }
    }

    // UTF-8 validation
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      decoder.decode(slice, { stream: bytesRead < sizeBytes });
    } catch {
      throw new WorkspaceError(
        "Non-UTF-8 text encoding is not supported",
        WorkspaceErrorCode.UNSUPPORTED_TEXT_ENCODING,
        415
      );
    }
  } finally {
    fs.closeSync(fd);
  }
}

export interface LineOffset {
  start: number;
  end: number;
}

/**
 * Calculates start and end character offsets for each 1-based line.
 */
export function getLineOffsets(text: string): LineOffset[] {
  const lines: LineOffset[] = [];
  let lineStart = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      lines.push({ start: lineStart, end: i + 1 });
      lineStart = i + 1;
    }
  }
  if (lineStart < text.length) {
    lines.push({ start: lineStart, end: text.length });
  }
  return lines;
}

