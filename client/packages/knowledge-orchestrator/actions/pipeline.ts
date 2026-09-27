import { defineAction, decodeText } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { OrchestratorError } from "../src/errors.ts";
import {
  runPipeline,
  generateMarkdownReport,
  type PipelineHooks,
  type RepoResult,
} from "../src/pipeline-core.ts";

export type Input = ActionInput<"orchestrator.pipeline">;
export type Output = ActionOutput<"orchestrator.pipeline">;

export default defineAction<Input, Output>(async (input, ctx) => {
  const profile = input.profile ?? "skm";
  const dryRun = input.dryRun ?? false;
  const dispatchCmd = input.dispatchCmd ?? "";
  const timeout = input.timeout ?? 15;
  const interval = input.interval ?? 10;
  const only = input.only ?? null;
  const skipSystemKnowledge = input.skipSystemKnowledge ?? false;
  const reportFile = input.reportFile ?? "maintenance-report.md";
  const logFile = input.logFile ?? null;

  ctx.log.info("Starting orchestrator.pipeline", {
    profile,
    dryRun,
    only,
    timeout,
    interval,
    skipSystemKnowledge,
    logFile,
  });

  if (!dryRun && !dispatchCmd) {
    throw new OrchestratorError(
      "缺少必需参数：--dispatch-cmd <template>。实际运行时必须提供派发命令模版。",
      "MISSING_DISPATCH_CMD",
      400
    );
  }

  const hooks: PipelineHooks = {
    execFn: async (cmd: string) => {
      if (ctx.signal.aborted) {
        throw new OrchestratorError("Pipeline execution aborted by caller", "OPERATION_ABORTED", 499);
      }
      ctx.log.debug(`Executing query command: ${cmd}`);
      const res = await ctx.process.run(
        {
          spec: {
            executable: "sh",
            args: ["-c", cmd],
            io: { mode: "pipe" },
          },
          timeoutMs: 60000,
          maxOutputBytes: 10 * 1024 * 1024,
        },
        { signal: ctx.signal }
      );
      const stdout = decodeText(res.chunks.filter((c) => c.stream === "stdout"));
      const stderr = decodeText(res.chunks.filter((c) => c.stream === "stderr"));
      if (res.exit.code !== 0 && !stdout) {
        throw new Error(`Command failed with code ${res.exit.code}: ${stderr || cmd}`);
      }
      return { stdout, stderr };
    },
    dispatchFn: async (cmd: string) => {
      if (ctx.signal.aborted) {
        throw new OrchestratorError("Pipeline execution aborted by caller", "OPERATION_ABORTED", 499);
      }
      ctx.log.info(`Dispatching external agent command: ${cmd}`);
      const res = await ctx.process.run(
        {
          spec: {
            executable: "sh",
            args: ["-c", cmd],
            io: { mode: "pipe" },
          },
          timeoutMs: 30000,
          maxOutputBytes: 10 * 1024 * 1024,
        },
        { signal: ctx.signal }
      );
      if (res.exit.code !== 0) {
        const stderr = decodeText(res.chunks.filter((c) => c.stream === "stderr"));
        throw new Error(`派发命令异常退出，退出码 ${res.exit.code}: ${stderr}`);
      }
      return {
        pid: 0,
        output: decodeText(res.chunks.filter((c) => c.stream === "stdout")),
        exited: true,
      };
    },
    sleepFn: async (ms: number) => {
      if (ctx.signal.aborted) {
        throw new OrchestratorError("Pipeline execution aborted by caller", "OPERATION_ABORTED", 499);
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        if (ctx.signal) {
          ctx.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new OrchestratorError("Pipeline execution aborted by caller", "OPERATION_ABORTED", 499));
            },
            { once: true }
          );
        }
      });
    },
    onProgress: (stats: any) => {
      ctx.progress.report(
        stats.processed,
        stats.total,
        stats.activeRepo ? `当前活跃仓: ${stats.activeRepo}` : "流水线调度中"
      );
    },
    logFn: (msg: string) => {
      ctx.log.info(msg);
    },
  };

  const rawResult = await runPipeline(
    {
      profile,
      dispatchCmd,
      timeout,
      interval,
      dryRun,
      only,
      skipSystemKnowledge,
      reportFile,
      logFile,
    },
    hooks
  );

  if (rawResult.dryRun) {
    const mdReport = generateMarkdownReport({
      profile,
      total: rawResult.total,
      completed: 0,
      skipped: rawResult.skipped,
      failed: 0,
      totalElapsedMs: 0,
      results: [],
    });

    return {
      success: true,
      total: rawResult.total,
      completed: 0,
      skipped: rawResult.skipped,
      failed: 0,
      durationMs: 0,
      report: mdReport,
      reportFile: null,
      logFile: null,
      results: [],
      dryRunResults: rawResult.dryRunOutput.map((item) => ({
        repo: item.repo,
        path: item.path,
        repoType: item.repoType,
        renderedCommand: item.renderedCommand,
        placeholders: item.placeholders,
      })),
    };
  }

  const results = rawResult.results.map((r) => ({
    repo: r.repo,
    path: r.path,
    repoType: (r.repoType === "system_knowledge" ? "system_knowledge" : "code") as "code" | "system_knowledge",
    status: r.status,
    ...(r.targetCommit ? { targetCommit: r.targetCommit } : {}),
    durationMs: r.durationMs ?? 0,
    ...(r.message ? { message: r.message } : {}),
  }));

  return {
    success: rawResult.failed === 0,
    total: rawResult.total,
    completed: rawResult.completed,
    skipped: rawResult.skipped,
    failed: rawResult.failed,
    durationMs: rawResult.totalElapsedMs,
    report: rawResult.markdownReport,
    reportFile: rawResult.reportSaved && reportFile ? reportFile : null,
    logFile: rawResult.logFile ?? null,
    results,
    dryRunResults: [],
  };
});
