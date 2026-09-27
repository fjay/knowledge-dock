import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WorkspacePathPolicy } from "../src/path-policy.ts";
import { isSensitivePath } from "../src/file-policy.ts";

describe("WorkspacePathPolicy & FilePolicy", () => {
  it("allows normal paths within workspace root", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-test-"));
    try {
      const srcDir = path.join(tmpDir, "src");
      fs.mkdirSync(srcDir);
      const testFile = path.join(srcDir, "index.ts");
      fs.writeFileSync(testFile, "console.log('hi');");

      const policy = new WorkspacePathPolicy(tmpDir);
      const resolved = policy.resolveAndValidate("src/index.ts");

      assert.equal(resolved.relativePath, "src/index.ts");
      assert.equal(resolved.absolutePath, testFile);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects path traversal outside workspace root", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-test-"));
    try {
      const policy = new WorkspacePathPolicy(tmpDir);
      assert.throws(
        () => policy.resolveAndValidate("../outside.txt"),
        (err: any) => err.code === "PATH_OUTSIDE_WORKSPACE"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("identifies sensitive paths and allows .env.example", () => {
    assert.equal(isSensitivePath(".env"), true);
    assert.equal(isSensitivePath(".env.local"), true);
    assert.equal(isSensitivePath(".git/config"), true);
    assert.equal(isSensitivePath("sub/.git/HEAD"), true);
    assert.equal(isSensitivePath("id_rsa"), true);
    assert.equal(isSensitivePath("id_rsa.pub"), true);
    assert.equal(isSensitivePath("cert.pem"), true);
    assert.equal(isSensitivePath("priv.key"), true);
    assert.equal(isSensitivePath(".npmrc"), true);
    assert.equal(isSensitivePath(".pypirc"), true);

    // Whitelisted exceptions
    assert.equal(isSensitivePath(".env.example"), false);
    assert.equal(isSensitivePath("config/.env.example"), false);
    assert.equal(isSensitivePath(".env.template"), false);
    assert.equal(isSensitivePath("normal.ts"), false);
  });

  it("blocks access to sensitive paths in resolveAndValidate", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-test-"));
    try {
      fs.writeFileSync(path.join(tmpDir, ".env"), "SECRET=123");
      const policy = new WorkspacePathPolicy(tmpDir);

      assert.throws(
        () => policy.resolveAndValidate(".env"),
        (err: any) => err.code === "SENSITIVE_PATH_DENIED"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("blocks symlink escaping workspace root", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-test-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-outside-"));
    try {
      const outsideFile = path.join(outsideDir, "secret.txt");
      fs.writeFileSync(outsideFile, "outside content");

      const linkPath = path.join(tmpDir, "link-outside.txt");
      fs.symlinkSync(outsideFile, linkPath);

      const policy = new WorkspacePathPolicy(tmpDir);
      assert.throws(
        () => policy.resolveAndValidate("link-outside.txt"),
        (err: any) => err.code === "SYMLINK_OUTSIDE_WORKSPACE"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
