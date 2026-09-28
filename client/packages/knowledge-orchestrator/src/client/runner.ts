import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * 默认命令执行函数（基于 child_process.exec）
 */
export async function defaultExec(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });
}

/**
 * 异步触发派发命令（非阻塞启动外部智能体）
 */
export function triggerDispatch(
  command: string,
  { timeoutMs = 1500, execFn = null }: { timeoutMs?: number; execFn?: ((cmd: string) => any) | null } = {}
): Promise<any> {
  if (execFn) {
    return Promise.resolve(execFn(command));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    let isSettled = false;

    child.on("error", (err: Error) => {
      if (!isSettled) {
        isSettled = true;
        reject(err);
      }
    });

    child.on("exit", (code: number | null) => {
      if (!isSettled) {
        isSettled = true;
        if (code !== 0 && code !== null) {
          reject(new Error(`派发命令异常退出，退出码 ${code}: ${output.trim()}`));
        } else {
          resolve({ pid: child.pid, output: output.trim(), exited: true });
        }
      }
    });

    setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        resolve({ pid: child.pid, output: output.trim(), exited: false });
      }
    }, timeoutMs);
  });
}
