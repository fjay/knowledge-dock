import fs from "node:fs";
import { createRequire } from "node:module";

export type RipgrepSource = "env" | "vscode-ripgrep" | "system";

export interface RipgrepResolution {
  /**
   * 可执行文件路径或系统命令名称
   */
  executable: string;
  /**
   * 寻址来源
   */
  source: RipgrepSource;
}

export interface ResolveRipgrepOptions {
  /**
   * 自定义环境变量字典，默认使用 process.env
   */
  env?: Record<string, string | undefined>;
  /**
   * 自定义文件存在性检查函数，默认使用 fs.existsSync
   */
  fsExists?: (filePath: string) => boolean;
  /**
   * 自定义 @vscode/ripgrep 模块加载器
   */
  loadModule?: () => { rgPath?: unknown } | undefined | null;
  /**
   * 兜底可执行文件命令或路径，默认回退至 "rg"
   */
  fallback?: string;
}

/**
 * 默认加载 @vscode/ripgrep 导出的模块
 */
function defaultLoadVscodeRipgrep(): { rgPath?: unknown } | undefined {
  try {
    const require = createRequire(import.meta.url);
    return require("@vscode/ripgrep") as { rgPath?: unknown };
  } catch {
    return undefined;
  }
}

/**
 * 解析并寻址 ripgrep 可执行文件：
 * 优先级 1：读取环境变量覆盖（RG_PATH 或 RIPGREP_PATH）；
 * 优先级 2：加载并校验 @vscode/ripgrep 导出的 rgPath（需检查文件存在性）；
 * 优先级 3：透明回退至系统的 "rg" 命令。
 */
export function resolveRipgrep(options?: ResolveRipgrepOptions): RipgrepResolution {
  const env = options?.env ?? process.env;
  const fsExists = options?.fsExists ?? fs.existsSync;
  const fallback = options?.fallback ?? "rg";

  // 优先级 1：环境变量覆盖
  const envPath = env.RG_PATH?.trim() || env.RIPGREP_PATH?.trim();
  if (envPath) {
    return {
      executable: envPath,
      source: "env",
    };
  }

  // 优先级 2：@vscode/ripgrep 内置预编译文件
  try {
    const mod = options?.loadModule ? options.loadModule() : defaultLoadVscodeRipgrep();
    if (mod && typeof mod.rgPath === "string") {
      const candidatePath = mod.rgPath.trim();
      if (candidatePath && fsExists(candidatePath)) {
        return {
          executable: candidatePath,
          source: "vscode-ripgrep",
        };
      }
    }
  } catch {
    // 忽略加载异常，继续回退
  }

  // 优先级 3：系统命令透明回退
  return {
    executable: fallback,
    source: "system",
  };
}

/**
 * 获取解析后的 ripgrep 可执行文件路径字符串
 */
export function resolveRipgrepPath(options?: ResolveRipgrepOptions): string {
  return resolveRipgrep(options).executable;
}
