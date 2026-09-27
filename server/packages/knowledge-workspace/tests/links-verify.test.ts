import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTestRuntime } from "@actiondock/testing";
import linksVerifyAction from "../actions/links-verify.ts";
import { WorkspaceError } from "../src/errors.ts";

describe("workspace/links.verify", () => {
  it("covers normal relative links, local image assets, and heading anchor matching", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-links-"));
    try {
      fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "images"), { recursive: true });

      fs.writeFileSync(path.join(tmpDir, "images", "arch.png"), "fake image bytes");
      fs.writeFileSync(
        path.join(tmpDir, "docs", "guide.md"),
        "# Guide\n\n## Setup & Installation\n\nGuide content.\n"
      );
      fs.writeFileSync(
        path.join(tmpDir, "README.md"),
        "# Project\n\n" +
          "See [Guide](./docs/guide.md) for overview.\n" +
          "View ![Architecture](./images/arch.png) diagram.\n" +
          "Check [Installation](./docs/guide.md#setup-installation) section.\n"
      );

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const res = await runtime.run(linksVerifyAction, {});

      assert.equal(res.scannedFiles, 2);
      assert.equal(res.totalLinks, 3);
      assert.equal(res.brokenCount, 0);
      assert.deepEqual(res.brokenLinks, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("captures non-existent target files (TARGET_NOT_FOUND) with line number and file path", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-links-"));
    try {
      fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true });

      fs.writeFileSync(
        path.join(tmpDir, "docs", "broken.md"),
        "# Broken Links\n" +
          "See [Missing Doc](./does-not-exist.md) for details.\n" +
          "Here is text.\n" +
          "Check ![Missing Image](../assets/missing.png) here.\n"
      );

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const res = await runtime.run(linksVerifyAction, {});

      assert.equal(res.scannedFiles, 1);
      assert.equal(res.totalLinks, 2);
      assert.equal(res.brokenCount, 2);

      assert.deepEqual(res.brokenLinks[0], {
        file: "docs/broken.md",
        line: 2,
        link: "./does-not-exist.md",
        target: "docs/does-not-exist.md",
        reason: "TARGET_NOT_FOUND",
      });

      assert.deepEqual(res.brokenLinks[1], {
        file: "docs/broken.md",
        line: 4,
        link: "../assets/missing.png",
        target: "assets/missing.png",
        reason: "TARGET_NOT_FOUND",
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("captures non-existent heading anchors in existing target files (ANCHOR_NOT_FOUND)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-links-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "target.md"),
        "# Target Document\n\n## Existing Heading\n\nContent.\n"
      );
      fs.writeFileSync(
        path.join(tmpDir, "index.md"),
        "# Index\n\n" +
          "Go to [Nonexistent Heading](./target.md#missing-heading-title).\n"
      );

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const res = await runtime.run(linksVerifyAction, {});

      assert.equal(res.scannedFiles, 2);
      assert.equal(res.totalLinks, 1);
      assert.equal(res.brokenCount, 1);

      assert.deepEqual(res.brokenLinks[0], {
        file: "index.md",
        line: 3,
        link: "./target.md#missing-heading-title",
        target: "#missing-heading-title",
        reason: "ANCHOR_NOT_FOUND",
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("verifies same-document anchors (#heading) for valid and invalid scenarios", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-links-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "doc.md"),
        "# Main Title\n" +
          "## Introduction\n" +
          "Read [Intro](#introduction) or back to [Top](#).\n" +
          "Read [Missing](#invalid-section).\n"
      );

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const res = await runtime.run(linksVerifyAction, {});

      assert.equal(res.scannedFiles, 1);
      assert.equal(res.totalLinks, 3);
      assert.equal(res.brokenCount, 1);

      assert.deepEqual(res.brokenLinks[0], {
        file: "doc.md",
        line: 4,
        link: "#invalid-section",
        target: "#invalid-section",
        reason: "ANCHOR_NOT_FOUND",
      });

      // When checkAnchors is false, anchor validation is bypassed
      const resNoAnchors = await runtime.run(linksVerifyAction, {
        checkAnchors: false,
      });
      assert.equal(resNoAnchors.brokenCount, 0);
      assert.deepEqual(resNoAnchors.brokenLinks, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ignores external network links (http/https/mailto/tel/data/ftp)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-links-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "valid.md"), "# Valid File\n");
      fs.writeFileSync(
        path.join(tmpDir, "external.md"),
        "# External Links\n" +
          "- [Google](https://www.google.com)\n" +
          "- [HTTP](http://example.com/api)\n" +
          "- [Mail](mailto:developer@example.com)\n" +
          "- [Phone](tel:+1234567890)\n" +
          "- [FTP](ftp://files.example.com/archive)\n" +
          "- ![Data URI](data:image/png;base64,iVBORw0KGgo=)\n" +
          "- [Local Target](./valid.md)\n"
      );

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const res = await runtime.run(linksVerifyAction, {});

      assert.equal(res.scannedFiles, 2);
      // Only ./valid.md counts towards totalLinks
      assert.equal(res.totalLinks, 1);
      assert.equal(res.brokenCount, 0);
      assert.deepEqual(res.brokenLinks, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("filters hidden directories, node_modules, and custom ignoreDirs", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-links-"));
    try {
      fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, ".hidden"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "node_modules", "pkg"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "custom-ignored"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "scanned-dir"), { recursive: true });

      fs.writeFileSync(
        path.join(tmpDir, ".git", "bad.md"),
        "[Broken](does-not-exist.md)\n"
      );
      fs.writeFileSync(
        path.join(tmpDir, ".hidden", "bad.md"),
        "[Broken](does-not-exist.md)\n"
      );
      fs.writeFileSync(
        path.join(tmpDir, "node_modules", "pkg", "bad.md"),
        "[Broken](does-not-exist.md)\n"
      );
      fs.writeFileSync(
        path.join(tmpDir, "custom-ignored", "bad.md"),
        "[Broken](does-not-exist.md)\n"
      );
      fs.writeFileSync(
        path.join(tmpDir, "scanned-dir", "test.md"),
        "# Scanned\n[Broken Link](./missing-file.md)\n"
      );

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const res = await runtime.run(linksVerifyAction, {
        ignoreDirs: ["custom-ignored"],
      });

      assert.equal(res.scannedFiles, 1);
      assert.equal(res.brokenCount, 1);
      assert.equal(res.brokenLinks[0].file, "scanned-dir/test.md");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("scopes scan to specified subdirectory or single markdown file", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-links-"));
    try {
      fs.mkdirSync(path.join(tmpDir, "sub"), { recursive: true });

      fs.writeFileSync(
        path.join(tmpDir, "root.md"),
        "# Root\n[Broken Root](./missing-root.md)\n"
      );
      fs.writeFileSync(
        path.join(tmpDir, "sub", "doc1.md"),
        "# Sub Doc 1\n[Broken Sub](./missing-sub.md)\n"
      );
      fs.writeFileSync(
        path.join(tmpDir, "sub", "doc2.md"),
        "# Sub Doc 2\nNo links here.\n"
      );

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      // 1. Scope to subdirectory "sub"
      const subRes = await runtime.run(linksVerifyAction, {
        path: "sub",
      });

      assert.equal(subRes.scannedFiles, 2);
      assert.equal(subRes.brokenCount, 1);
      assert.equal(subRes.brokenLinks[0].file, "sub/doc1.md");

      // 2. Scope to single file "sub/doc1.md"
      const fileRes = await runtime.run(linksVerifyAction, {
        path: "sub/doc1.md",
      });

      assert.equal(fileRes.scannedFiles, 1);
      assert.equal(fileRes.brokenCount, 1);
      assert.equal(fileRes.brokenLinks[0].file, "sub/doc1.md");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws FILE_NOT_FOUND when specified path does not exist", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-links-"));
    try {
      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        async () => {
          await runtime.run(linksVerifyAction, {
            path: "nonexistent/directory",
          });
        },
        (err: any) => {
          assert.equal(err.code, "FILE_NOT_FOUND");
          return true;
        }
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("supports Chinese headings, duplicate headings, and multiple links on a single line", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-links-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "guide.md"),
        "# 核心工程指南\n\n" +
          "## 快速入门\n\n" +
          "内容。\n\n" +
          "## 快速入门\n\n" +
          "重复标题内容。\n"
      );
      fs.writeFileSync(
        path.join(tmpDir, "index.md"),
        "# 首页\n\n" +
          "[第一项](./guide.md#快速入门) 和 [第二项](./guide.md#快速入门-1)\n" +
          "[第三项无效](./guide.md#快速入门-2) [第四项无效](./missing.md)\n"
      );

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const res = await runtime.run(linksVerifyAction, {});

      assert.equal(res.scannedFiles, 2);
      assert.equal(res.totalLinks, 4);
      assert.equal(res.brokenCount, 2);

      assert.deepEqual(res.brokenLinks[0], {
        file: "index.md",
        line: 4,
        link: "./guide.md#快速入门-2",
        target: "#快速入门-2",
        reason: "ANCHOR_NOT_FOUND",
      });

      assert.deepEqual(res.brokenLinks[1], {
        file: "index.md",
        line: 4,
        link: "./missing.md",
        target: "missing.md",
        reason: "TARGET_NOT_FOUND",
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ignores dead link examples inside fenced code blocks (``` and ~~~)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-links-fence-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "valid.md"),
        "# Valid Doc\n\n## Section One\n\nContent.\n"
      );
      fs.writeFileSync(
        path.join(tmpDir, "code-blocks.md"),
        "# Code Blocks Demo\n\n" +
          "Here is normal text with [Real Link](./valid.md).\n\n" +
          "```markdown\n" +
          "See [Missing Doc 1](./does-not-exist-1.md) for details.\n" +
          "Check ![Missing Image 1](./missing-1.png).\n" +
          "Go to [Missing Anchor](./valid.md#nonexistent-heading).\n" +
          "```\n\n" +
          "~~~typescript\n" +
          "const url = '[Missing Doc 2](../does-not-exist-2.md)';\n" +
          "~~~\n\n" +
          "````markdown\n" +
          "```\n" +
          "Nested [Missing Doc 3](./does-not-exist-3.md)\n" +
          "```\n" +
          "````\n\n" +
          "And [Real Anchor Link](./valid.md#section-one).\n"
      );

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const res = await runtime.run(linksVerifyAction, {});

      assert.equal(res.scannedFiles, 2);
      assert.equal(res.totalLinks, 2);
      assert.equal(res.brokenCount, 0);
      assert.deepEqual(res.brokenLinks, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ignores dead link patterns inside inline code spans (`...`)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-links-inline-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "valid.md"),
        "# Valid Document\n\nFunction documentation.\n"
      );
      fs.writeFileSync(
        path.join(tmpDir, "inline-demo.md"),
        "# Inline Code Demo\n\n" +
          "Use single backtick `[createOrder](../../foo.ts)` as an example.\n" +
          "Use double backticks ``[deleteOrder](../../bar.ts)`` as another example.\n" +
          "Use triple backticks ```[updateOrder](../../baz.ts)``` inline.\n" +
          "Real link with inline code in label: [`validFunc()`](./valid.md).\n" +
          "Mixed line: `[sample](./fake.md)` followed by [Real Link](./valid.md).\n"
      );

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const res = await runtime.run(linksVerifyAction, {});

      assert.equal(res.scannedFiles, 2);
      assert.equal(res.totalLinks, 2);
      assert.equal(res.brokenCount, 0);
      assert.deepEqual(res.brokenLinks, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ignores links inside single-line and multi-line HTML comments (<!-- ... -->)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-links-comment-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "valid.md"),
        "# Valid Document\n\nValid content.\n"
      );
      fs.writeFileSync(
        path.join(tmpDir, "comments-demo.md"),
        "# HTML Comments Demo\n\n" +
          "<!-- Single line comment [broken1](./dead-1.md) -->\n" +
          "Prefix [Real Link 1](./valid.md) <!-- inline comment [broken2](./dead-2.md) --> suffix.\n\n" +
          "<!--\n" +
          "Multi-line comment block:\n" +
          "See [broken3](./dead-3.md)\n" +
          "Check ![broken img](./dead.png)\n" +
          "-->\n\n" +
          "<!-- Comment with inline code `[broken4](./dead-4.md)` -->\n" +
          "Final [Real Link 2](./valid.md).\n"
      );

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const res = await runtime.run(linksVerifyAction, {});

      assert.equal(res.scannedFiles, 2);
      assert.equal(res.totalLinks, 2);
      assert.equal(res.brokenCount, 0);
      assert.deepEqual(res.brokenLinks, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("accurately captures real broken links and anchors while filtering code blocks, inline code, and comments", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-links-mixed-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "existing.md"),
        "# Existing Title\n\n## Valid Section\n\nBody.\n"
      );
      fs.writeFileSync(
        path.join(tmpDir, "mixed.md"),
        "# Mixed Document\n\n" +
          "Here is [Real Valid](./existing.md#valid-section)\n\n" +
          "```ts\n" +
          "[Code Dead](./fake-code.md)\n" +
          "```\n\n" +
          "Real broken link: [Missing File](./actual-missing.md)\n" +
          "Inline dead `[Inline Dead](./fake-inline.md)` and real broken anchor: [Missing Anchor](./existing.md#no-such-heading)\n" +
          "<!-- [Comment Dead](./fake-comment.md) -->\n" +
          "<!--\n" +
          "Multi-line comment dead link [Multi Dead](./fake-multi.md)\n" +
          "-->\n"
      );

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const res = await runtime.run(linksVerifyAction, {});

      assert.equal(res.scannedFiles, 2);
      assert.equal(res.totalLinks, 3);
      assert.equal(res.brokenCount, 2);

      assert.deepEqual(res.brokenLinks[0], {
        file: "mixed.md",
        line: 9,
        link: "./actual-missing.md",
        target: "actual-missing.md",
        reason: "TARGET_NOT_FOUND",
      });

      assert.deepEqual(res.brokenLinks[1], {
        file: "mixed.md",
        line: 10,
        link: "./existing.md#no-such-heading",
        target: "#no-such-heading",
        reason: "ANCHOR_NOT_FOUND",
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
