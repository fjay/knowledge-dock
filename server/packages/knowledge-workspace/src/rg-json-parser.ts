import type { WorkspacePathPolicy } from "./path-policy.ts";
import { isSensitivePath } from "./file-policy.ts";
import { MAX_SEARCH_RESULTS, MAX_MATCH_LINE_BYTES } from "./limits.ts";

export interface WorkspaceRgMatch {
  path: string;
  line: number;
  text: string;
  before?: Array<{ line: number; text: string }>;
  after?: Array<{ line: number; text: string }>;
  truncated?: boolean;
}

export interface RgJsonStreamParserOptions {
  pathPolicy: WorkspacePathPolicy;
  maxResults?: number;
  maxColumns?: number;
  beforeContext?: number;
  afterContext?: number;
}

/**
 * Parses streaming ripgrep JSON Lines events, associates context lines,
 * enforces column/result limits, and guarantees relative paths.
 */
export class RgJsonStreamParser {
  private lineBuffer = "";
  private matches: WorkspaceRgMatch[] = [];
  private currentFilePath = "";
  private recentContext: Array<{ line: number; text: string }> = [];
  private currentMatch: WorkspaceRgMatch | null = null;
  private pendingAfterRemaining = 0;
  private maxResults: number;
  private maxColumns: number;
  private pathPolicy: WorkspacePathPolicy;
  private beforeContextCount: number;
  private afterContextCount: number;

  constructor(options: RgJsonStreamParserOptions) {
    this.pathPolicy = options.pathPolicy;
    this.maxResults = options.maxResults ?? MAX_SEARCH_RESULTS;
    this.maxColumns = options.maxColumns ?? MAX_MATCH_LINE_BYTES;
    this.beforeContextCount = options.beforeContext ?? 0;
    this.afterContextCount = options.afterContext ?? 0;
  }

  /**
   * Ingest a chunk of text, split by newlines, and process JSON lines.
   * Returns true if maxResults limit was reached.
   */
  feed(chunk: string): boolean {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split("\n");
    // Preserve incomplete trailing line
    this.lineBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const hitLimit = this.processJsonLine(trimmed);
      if (hitLimit) {
        return true;
      }
    }
    return false;
  }

  /**
   * Flushes any remaining line buffer.
   */
  flush(): boolean {
    if (this.lineBuffer.trim()) {
      const hitLimit = this.processJsonLine(this.lineBuffer.trim());
      this.lineBuffer = "";
      return hitLimit;
    }
    return false;
  }

  private processJsonLine(lineStr: string): boolean {
    let event: any;
    try {
      event = JSON.parse(lineStr);
    } catch {
      return false;
    }

    if (!event || typeof event !== "object") return false;

    if (event.type === "begin") {
      this.currentFilePath = this.pathPolicy.toRelativePath(event.data?.path?.text || "");
      this.recentContext = [];
      this.currentMatch = null;
      this.pendingAfterRemaining = 0;
      return false;
    }

    if (event.type === "end") {
      this.currentFilePath = "";
      this.recentContext = [];
      this.currentMatch = null;
      this.pendingAfterRemaining = 0;
      return false;
    }

    const relPath = this.pathPolicy.toRelativePath(
      event.data?.path?.text || this.currentFilePath
    );

    // Filter out sensitive files (Section 23)
    if (isSensitivePath(relPath)) {
      return false;
    }

    const rawLineText = (event.data?.lines?.text || "").replace(/\r?\n$/, "");
    const lineNumber = event.data?.line_number ?? 1;

    if (event.type === "context") {
      const cleaned = this.cleanLine(rawLineText);

      // If there's an active match expecting after-context lines
      if (this.currentMatch && this.pendingAfterRemaining > 0) {
        if (!this.currentMatch.after) {
          this.currentMatch.after = [];
        }
        this.currentMatch.after.push({
          line: lineNumber,
          text: cleaned.text,
        });
        this.pendingAfterRemaining--;
      }

      // Buffer context for potential upcoming matches
      this.recentContext.push({
        line: lineNumber,
        text: cleaned.text,
      });
      if (this.beforeContextCount > 0 && this.recentContext.length > this.beforeContextCount) {
        this.recentContext.shift();
      }
      return false;
    }

    if (event.type === "match") {
      const cleaned = this.cleanLine(rawLineText);
      const matchObj: WorkspaceRgMatch = {
        path: relPath,
        line: lineNumber,
        text: cleaned.text,
      };

      if (cleaned.truncated) {
        matchObj.truncated = true;
      }

      if (this.beforeContextCount > 0 && this.recentContext.length > 0) {
        matchObj.before = [...this.recentContext];
      }
      this.recentContext = [];

      this.currentMatch = matchObj;
      this.pendingAfterRemaining = this.afterContextCount;

      this.matches.push(matchObj);

      if (this.matches.length >= this.maxResults) {
        return true;
      }
    }

    return false;
  }

  private cleanLine(lineText: string): { text: string; truncated: boolean } {
    const byteLength = Buffer.byteLength(lineText, "utf8");
    if (byteLength > this.maxColumns) {
      const buf = Buffer.from(lineText, "utf8").subarray(0, this.maxColumns);
      return {
        text: buf.toString("utf8"),
        truncated: true,
      };
    }
    return {
      text: lineText,
      truncated: false,
    };
  }

  getResults(): WorkspaceRgMatch[] {
    return this.matches;
  }
}
