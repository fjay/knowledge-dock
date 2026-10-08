import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const rawMarkdown = "---\nid: 20260924-a1b2c3\ntitle: 正文输出\n---\n\n# 正文输出\n\n保留原始换行。\n";

describe("knowledge.get CLI output integration", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-get-cli-"));
    const pendingDir = path.join(tmpDir, "inbox", "pending");
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(path.join(pendingDir, "20260924-112345-a1b2c3-content.md"), rawMarkdown, "utf8");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runCli(options: string[] = []) {
    const result = spawnSync("ad", [
      "run", "knowledge.get",
      "--data-dir", path.join(tmpDir, "data"),
      "-c", `KNOWLEDGE_INBOX_ROOT=${path.join(tmpDir, "inbox")}`,
      ...options,
      "--", "id=20260924-a1b2c3",
    ], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, ACTIONDOCK_HOME: path.join(tmpDir, "home") },
      timeout: 15000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return result;
  }

  it("prints only raw content to stdout and metadata without duplicate body to stderr", () => {
    const result = runCli();
    assert.equal(result.stdout, `${rawMarkdown}\n`);
    assert.match(result.stderr, /"id": "20260924-a1b2c3"/);
    assert.match(result.stderr, /"status": "pending"/);
    assert.doesNotMatch(result.stderr, /"(?:content|body)"\s*:/);
  });

  it("keeps content and all metadata in the JSON execution envelope without body", () => {
    const result = JSON.parse(runCli(["--json"]).stdout);
    assert.equal(result.ok, true);
    assert.equal(typeof result.runId, "string");
    assert.equal(result.data.id, "20260924-a1b2c3");
    assert.equal(result.data.content, rawMarkdown);
    assert.equal(result.data.title, "正文输出");
    assert.equal(result.data.frontmatter.id, "20260924-a1b2c3");
    assert.equal(Object.hasOwn(result.data, "body"), false);
  });
});
