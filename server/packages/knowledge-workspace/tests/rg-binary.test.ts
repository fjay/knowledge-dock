import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveRipgrep, resolveRipgrepPath } from "../src/rg-binary.ts";

describe("rg-binary 寻址解析模块", () => {
  describe("环境变量优先分支", () => {
    it("优先读取 RG_PATH 环境变量", () => {
      const result = resolveRipgrep({
        env: {
          RG_PATH: "/custom/bin/rg-from-rg-path",
          RIPGREP_PATH: "/custom/bin/rg-from-ripgrep-path",
        },
      });

      assert.equal(result.executable, "/custom/bin/rg-from-rg-path");
      assert.equal(result.source, "env");
      assert.equal(
        resolveRipgrepPath({
          env: { RG_PATH: "/custom/bin/rg-from-rg-path" },
        }),
        "/custom/bin/rg-from-rg-path"
      );
    });

    it("当 RG_PATH 未设置时读取 RIPGREP_PATH 环境变量", () => {
      const result = resolveRipgrep({
        env: {
          RIPGREP_PATH: "/custom/bin/rg-from-ripgrep-path",
        },
      });

      assert.equal(result.executable, "/custom/bin/rg-from-ripgrep-path");
      assert.equal(result.source, "env");
    });

    it("当环境变量为空白字符串时忽略并继续向下寻址", () => {
      const result = resolveRipgrep({
        env: {
          RG_PATH: "   ",
          RIPGREP_PATH: "",
        },
        loadModule: () => ({ rgPath: "/mock/vscode/rg" }),
        fsExists: (p) => p === "/mock/vscode/rg",
      });

      assert.equal(result.executable, "/mock/vscode/rg");
      assert.equal(result.source, "vscode-ripgrep");
    });

    it("支持直接从全局 process.env 读取环境变量", () => {
      const originalRgPath = process.env.RG_PATH;
      const originalRipgrepPath = process.env.RIPGREP_PATH;
      try {
        process.env.RG_PATH = "/env-override-test/rg";
        delete process.env.RIPGREP_PATH;

        const result = resolveRipgrep();
        assert.equal(result.executable, "/env-override-test/rg");
        assert.equal(result.source, "env");
        assert.equal(resolveRipgrepPath(), "/env-override-test/rg");
      } finally {
        if (originalRgPath !== undefined) {
          process.env.RG_PATH = originalRgPath;
        } else {
          delete process.env.RG_PATH;
        }
        if (originalRipgrepPath !== undefined) {
          process.env.RIPGREP_PATH = originalRipgrepPath;
        } else {
          delete process.env.RIPGREP_PATH;
        }
      }
    });
  });

  describe("模块正常加载分支", () => {
    it("环境变量未指定时成功探测并校验 @vscode/ripgrep 导出的路径", () => {
      const result = resolveRipgrep({
        env: {},
        loadModule: () => ({ rgPath: "/mock/vscode/bin/rg" }),
        fsExists: (p) => p === "/mock/vscode/bin/rg",
      });

      assert.equal(result.executable, "/mock/vscode/bin/rg");
      assert.equal(result.source, "vscode-ripgrep");
      assert.equal(
        resolveRipgrepPath({
          env: {},
          loadModule: () => ({ rgPath: "/mock/vscode/bin/rg" }),
          fsExists: (p) => p === "/mock/vscode/bin/rg",
        }),
        "/mock/vscode/bin/rg"
      );
    });

    it("在当前真实运行环境中能够正确定位已安装的 @vscode/ripgrep 二进制文件", () => {
      const originalRgPath = process.env.RG_PATH;
      const originalRipgrepPath = process.env.RIPGREP_PATH;
      try {
        delete process.env.RG_PATH;
        delete process.env.RIPGREP_PATH;

        const result = resolveRipgrep();
        assert.equal(result.source, "vscode-ripgrep");
        assert.ok(result.executable.includes("@vscode/ripgrep"));
        assert.equal(fs.existsSync(result.executable), true);
      } finally {
        if (originalRgPath !== undefined) {
          process.env.RG_PATH = originalRgPath;
        }
        if (originalRipgrepPath !== undefined) {
          process.env.RIPGREP_PATH = originalRipgrepPath;
        }
      }
    });
  });

  describe("模块异常与回退分支", () => {
    it("当 @vscode/ripgrep 加载抛出异常时回退至系统 rg", () => {
      const result = resolveRipgrep({
        env: {},
        loadModule: () => {
          throw new Error("Cannot find module @vscode/ripgrep");
        },
      });

      assert.equal(result.executable, "rg");
      assert.equal(result.source, "system");
      assert.equal(
        resolveRipgrepPath({
          env: {},
          loadModule: () => {
            throw new Error("Cannot find module @vscode/ripgrep");
          },
        }),
        "rg"
      );
    });

    it("当 @vscode/ripgrep 未导出有效 rgPath 时回退至系统 rg", () => {
      const result = resolveRipgrep({
        env: {},
        loadModule: () => ({ rgPath: undefined }),
      });

      assert.equal(result.executable, "rg");
      assert.equal(result.source, "system");
    });

    it("当 @vscode/ripgrep 导出的文件在磁盘上不存在时回退至系统 rg", () => {
      const result = resolveRipgrep({
        env: {},
        loadModule: () => ({ rgPath: "/nonexistent/path/to/rg" }),
        fsExists: () => false,
      });

      assert.equal(result.executable, "rg");
      assert.equal(result.source, "system");
    });

    it("当文件存在性检查抛出异常时安全捕获并回退至系统 rg", () => {
      const result = resolveRipgrep({
        env: {},
        loadModule: () => ({ rgPath: "/invalid/path" }),
        fsExists: () => {
          throw new Error("Permission denied");
        },
      });

      assert.equal(result.executable, "rg");
      assert.equal(result.source, "system");
    });

    it("支持自定义 fallback 兜底命令", () => {
      const result = resolveRipgrep({
        env: {},
        loadModule: () => null,
        fallback: "custom-rg",
      });

      assert.equal(result.executable, "custom-rg");
      assert.equal(result.source, "system");
    });
  });
});
