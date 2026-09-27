import fs from "node:fs";
import path from "node:path";
import { defineAction } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { WorkspacePathPolicy } from "../src/path-policy.ts";
import { isRelativeInside } from "../src/path-policy.ts";
import { isSensitivePath } from "../src/file-policy.ts";

export type Input = ActionInput<"links.verify">;
export type Output = ActionOutput<"links.verify">;

const LINK_REGEX =
  /!?\[(?:\\.|[^\]])*\]\(((?:<[^>]+>|\\\(|\\\)|[^\(\)]|\((?:[^\(\)]|\([^\(\)]*\))*\))+)\)/g;

function maskInlineCode(line: string): string {
  let result = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\\" && i + 1 < line.length && line[i + 1] === "`") {
      result += line[i] + line[i + 1];
      i += 2;
      continue;
    }

    if (line[i] === "`") {
      let runLen = 0;
      while (i + runLen < line.length && line[i + runLen] === "`") {
        runLen++;
      }

      let closeIdx = -1;
      let j = i + runLen;
      while (j < line.length) {
        if (line[j] === "`") {
          let closeRunLen = 0;
          while (j + closeRunLen < line.length && line[j + closeRunLen] === "`") {
            closeRunLen++;
          }
          if (closeRunLen === runLen) {
            closeIdx = j;
            break;
          }
          j += closeRunLen;
        } else {
          j++;
        }
      }

      if (closeIdx !== -1) {
        const totalSpanLen = closeIdx + runLen - i;
        result += " ".repeat(totalSpanLen);
        i = closeIdx + runLen;
      } else {
        result += line.slice(i, i + runLen);
        i += runLen;
      }
    } else {
      result += line[i];
      i++;
    }
  }
  return result;
}

function maskHtmlComments(
  line: string,
  inComment: boolean
): { maskedLine: string; inComment: boolean } {
  let result = "";
  let idx = 0;

  while (idx < line.length) {
    if (inComment) {
      const closeIdx = line.indexOf("-->", idx);
      if (closeIdx === -1) {
        result += " ".repeat(line.length - idx);
        idx = line.length;
      } else {
        result += " ".repeat(closeIdx + 3 - idx);
        idx = closeIdx + 3;
        inComment = false;
      }
    } else {
      const openIdx = line.indexOf("<!--", idx);
      if (openIdx === -1) {
        result += line.slice(idx);
        idx = line.length;
      } else {
        result += line.slice(idx, openIdx);
        idx = openIdx;
        inComment = true;
      }
    }
  }

  return { maskedLine: result, inComment };
}

function cleanHeadingText(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-_]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * 代码围栏与 HTML 注释的行级状态机，供锚点提取与主扫描共用。
 * maskLine 在非注释分支中于注释遮蔽前应用（主扫描传入行内代码遮蔽）。
 */
interface FenceTracker {
  step: (line: string) => { fenced: boolean; lineToScan: string };
}

function createFenceTracker(
  maskLine: (line: string) => string = (line) => line
): FenceTracker {
  let currentFence: { char: string; len: number } | null = null;
  let inHtmlComment = false;

  const step = (line: string): { fenced: boolean; lineToScan: string } => {
    if (currentFence !== null) {
      const escapedChar = currentFence.char === "`" ? "`" : "~";
      const fenceCloseRegex = new RegExp(
        `^\\s*${escapedChar}{${currentFence.len},}\\s*$`
      );
      if (fenceCloseRegex.test(line)) {
        currentFence = null;
      }
      return { fenced: true, lineToScan: "" };
    }

    if (inHtmlComment) {
      const commentRes = maskHtmlComments(line, true);
      inHtmlComment = commentRes.inComment;
      return { fenced: false, lineToScan: maskLine(commentRes.maskedLine) };
    }

    const fenceOpenMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fenceOpenMatch) {
      const fenceChar = fenceOpenMatch[1][0];
      const fenceLen = fenceOpenMatch[1].length;
      const rest = fenceOpenMatch[2];

      if (!rest.includes(fenceChar)) {
        currentFence = { char: fenceChar, len: fenceLen };
        return { fenced: true, lineToScan: "" };
      }
    }

    const commentRes = maskHtmlComments(maskLine(line), false);
    inHtmlComment = commentRes.inComment;
    return { fenced: false, lineToScan: commentRes.maskedLine };
  };

  return { step };
}

function extractDocumentAnchors(content: string): Set<string> {
  const validAnchors = new Set<string>();
  const slugCounts = new Map<string, number>();

  const lines = content.split(/\r?\n/);
  const fenceTracker = createFenceTracker();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const stepRes = fenceTracker.step(line);
    if (stepRes.fenced) {
      continue;
    }
    const lineToScan = stepRes.lineToScan;

    const atxMatch = lineToScan.match(/^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    let headingText: string | undefined;

    if (atxMatch) {
      headingText = atxMatch[2];
    } else if (i < lines.length - 1) {
      const nextLine = lines[i + 1].trim();
      const trimmedLine = lineToScan.trim();
      if (trimmedLine.length > 0 && !trimmedLine.startsWith("#")) {
        if (/^={2,}$/.test(nextLine)) {
          headingText = trimmedLine;
          i++;
        } else if (/^-{2,}$/.test(nextLine) && !/^(\*|-|\+)\s/.test(trimmedLine)) {
          headingText = trimmedLine;
          i++;
        }
      }
    }

    if (headingText) {
      const cleaned = cleanHeadingText(headingText);
      const baseSlug = slugify(cleaned);
      if (baseSlug) {
        const count = (slugCounts.get(baseSlug) ?? 0) + 1;
        slugCounts.set(baseSlug, count);

        const slug = count === 1 ? baseSlug : `${baseSlug}-${count - 1}`;
        validAnchors.add(slug);
        validAnchors.add(slug.replace(/-+/g, "-"));
        validAnchors.add(cleaned.toLowerCase().replace(/\s+/g, "-"));
      }
    }

    const htmlAnchorRegex = /<(?:a|span|div)[^>]*\s+(?:id|name)=["']([^"']+)["']/gi;
    let htmlMatch: RegExpExecArray | null;
    while ((htmlMatch = htmlAnchorRegex.exec(lineToScan)) !== null) {
      const id = htmlMatch[1].trim();
      if (id) {
        validAnchors.add(id);
        validAnchors.add(id.toLowerCase());
      }
    }
  }

  return validAnchors;
}

function isValidAnchor(validAnchors: Set<string>, targetAnchor: string): boolean {
  const raw = targetAnchor.startsWith("#") ? targetAnchor.slice(1) : targetAnchor;
  if (!raw) {
    return true;
  }

  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Ignore malformed URI components
  }

  if (validAnchors.has(raw) || validAnchors.has(raw.toLowerCase())) {
    return true;
  }
  if (validAnchors.has(decoded) || validAnchors.has(decoded.toLowerCase())) {
    return true;
  }

  const rawSlug = raw.toLowerCase().replace(/\s+/g, "-");
  if (validAnchors.has(rawSlug)) {
    return true;
  }

  const decodedSlug = decoded.toLowerCase().replace(/\s+/g, "-");
  if (validAnchors.has(decodedSlug) || validAnchors.has(decodedSlug.replace(/-+/g, "-"))) {
    return true;
  }

  return false;
}

function isExternalLink(url: string): boolean {
  const lower = url.trim().toLowerCase();
  return (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("mailto:") ||
    lower.startsWith("tel:") ||
    lower.startsWith("data:") ||
    lower.startsWith("ftp://") ||
    lower.startsWith("//") ||
    lower.startsWith("javascript:")
  );
}

function parseDestination(raw: string): string {
  let trimmed = raw.trim();
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    if (end !== -1) {
      return trimmed.slice(1, end).trim();
    }
  }

  const titleMatch = trimmed.match(/\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/);
  if (titleMatch && titleMatch.index !== undefined) {
    return trimmed.slice(0, titleMatch.index).trim();
  }
  return trimmed;
}

function collectMarkdownFiles(
  dir: string,
  pathPolicy: WorkspacePathPolicy,
  ignoreDirNames: Set<string>,
  ignoreDirPaths: Set<string>
): string[] {
  const result: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    if (entry.name === "node_modules") {
      continue;
    }
    if (ignoreDirNames.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    const relFromRoot = pathPolicy.toRelativePath(fullPath);

    if (ignoreDirPaths.has(relFromRoot) || ignoreDirPaths.has(entry.name)) {
      continue;
    }
    if (isSensitivePath(relFromRoot)) {
      continue;
    }

    if (entry.isDirectory()) {
      result.push(
        ...collectMarkdownFiles(fullPath, pathPolicy, ignoreDirNames, ignoreDirPaths)
      );
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      result.push(fullPath);
    } else if (entry.isSymbolicLink()) {
      try {
        const symRes = pathPolicy.resolveAndValidate(relFromRoot);
        if (symRes.stat?.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          result.push(fullPath);
        }
      } catch {
        continue;
      }
    }
  }

  return result;
}

export default defineAction<Input, Output>(async (input, ctx) => {
  const workspaceRoot = ctx.config.get<string>("WORKSPACE_ROOT", process.cwd());
  const pathPolicy = new WorkspacePathPolicy(workspaceRoot);

  const targetPath = input.path ?? ".";
  const resolved = pathPolicy.resolveAndValidate(targetPath);

  const checkAnchors = input.checkAnchors !== false;
  const ignoreDirs = input.ignoreDirs ?? [];
  const ignoreDirNames = new Set(
    ignoreDirs.map((d) => path.basename(d.replace(/[/\\]+$/, "")))
  );
  const ignoreDirPaths = new Set(
    ignoreDirs.map((d) => d.replace(/^[./\\]+|[/\\]+$/g, ""))
  );

  let filesToScan: string[] = [];
  if (resolved.stat?.isFile()) {
    if (resolved.absolutePath.toLowerCase().endsWith(".md")) {
      filesToScan = [resolved.absolutePath];
    }
  } else if (resolved.stat?.isDirectory()) {
    filesToScan = collectMarkdownFiles(
      resolved.absolutePath,
      pathPolicy,
      ignoreDirNames,
      ignoreDirPaths
    );
  }

  filesToScan.sort();

  const anchorCache = new Map<string, Set<string>>();
  const brokenLinks: Output["brokenLinks"] = [];
  let totalLinks = 0;

  for (const file of filesToScan) {
    if (ctx.signal.aborted) {
      throw new Error("Verify operation aborted by caller");
    }

    let content = "";
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const currentDocRelPosix = pathPolicy.toRelativePath(file);
    const currentDocDir = path.dirname(file);
    const lines = content.split(/\r?\n/);

    const fenceTracker = createFenceTracker(maskInlineCode);

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (ctx.signal.aborted) {
        throw new Error("Verify operation aborted by caller");
      }

      const line = lines[lineIdx];
      const lineNumber = lineIdx + 1;

      const stepRes = fenceTracker.step(line);
      if (stepRes.fenced) {
        continue;
      }
      const lineToScan = stepRes.lineToScan;

      LINK_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = LINK_REGEX.exec(lineToScan)) !== null) {
        const rawTarget = match[1];
        const destination = parseDestination(rawTarget);
        if (!destination) {
          continue;
        }

        if (isExternalLink(destination)) {
          continue;
        }

        totalLinks++;

        let filePath = destination;
        let anchor: string | undefined;

        const hashIndex = destination.indexOf("#");
        if (hashIndex !== -1) {
          filePath = destination.slice(0, hashIndex);
          anchor = destination.slice(hashIndex + 1);
        }

        if (filePath === "") {
          if (checkAnchors) {
            let currentDocValidAnchors = anchorCache.get(file);
            if (!currentDocValidAnchors) {
              currentDocValidAnchors = extractDocumentAnchors(content);
              anchorCache.set(file, currentDocValidAnchors);
            }

            if (!isValidAnchor(currentDocValidAnchors, anchor ?? "")) {
              brokenLinks.push({
                file: currentDocRelPosix,
                line: lineNumber,
                link: destination,
                target: `#${anchor ?? ""}`,
                reason: "ANCHOR_NOT_FOUND",
              });
            }
          }
        } else {
          let cleanFilePath = filePath;
          const queryIdx = cleanFilePath.indexOf("?");
          if (queryIdx !== -1) {
            cleanFilePath = cleanFilePath.slice(0, queryIdx);
          }

          let decodedFilePath = cleanFilePath;
          try {
            decodedFilePath = decodeURIComponent(cleanFilePath);
          } catch {
            // ignore malformed uri
          }
          decodedFilePath = decodedFilePath.replace(/\\/g, "/");

          let targetAbsolute: string;
          if (decodedFilePath.startsWith("/")) {
            targetAbsolute = path.resolve(
              workspaceRoot,
              decodedFilePath.replace(/^\/+/, "")
            );
          } else {
            targetAbsolute = path.resolve(currentDocDir, decodedFilePath);
          }

          const targetRelFromRoot = path.relative(workspaceRoot, targetAbsolute);
          const inside = isRelativeInside(targetRelFromRoot);
          const targetRelPosix =
            targetRelFromRoot === ""
              ? "."
              : targetRelFromRoot.split(path.sep).join("/");

          let exists = false;
          if (inside) {
            try {
              fs.statSync(targetAbsolute);
              exists = true;
            } catch {
              exists = false;
            }
          }

          if (!exists) {
            brokenLinks.push({
              file: currentDocRelPosix,
              line: lineNumber,
              link: destination,
              target: targetRelPosix,
              reason: "TARGET_NOT_FOUND",
            });
          } else if (anchor !== undefined && checkAnchors) {
            if (targetAbsolute.toLowerCase().endsWith(".md")) {
              let targetDocValidAnchors = anchorCache.get(targetAbsolute);
              if (!targetDocValidAnchors) {
                try {
                  const targetContent = fs.readFileSync(targetAbsolute, "utf8");
                  targetDocValidAnchors = extractDocumentAnchors(targetContent);
                } catch {
                  targetDocValidAnchors = new Set<string>();
                }
                anchorCache.set(targetAbsolute, targetDocValidAnchors);
              }

              if (!isValidAnchor(targetDocValidAnchors, anchor)) {
                brokenLinks.push({
                  file: currentDocRelPosix,
                  line: lineNumber,
                  link: destination,
                  target: `#${anchor}`,
                  reason: "ANCHOR_NOT_FOUND",
                });
              }
            }
          }
        }
      }
    }
  }

  return {
    scannedFiles: filesToScan.length,
    totalLinks,
    brokenCount: brokenLinks.length,
    brokenLinks,
  };
});
