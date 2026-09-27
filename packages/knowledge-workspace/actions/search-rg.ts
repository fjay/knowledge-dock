import { defineAction, createIncrementalTextDecoder, decodeBytes } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { WorkspacePathPolicy } from "../src/path-policy.ts";
import { buildRgArgs } from "../src/rg-args.ts";
import { RgJsonStreamParser } from "../src/rg-json-parser.ts";
import {
  RG_TIMEOUT_MS,
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_OUTPUT_BYTES,
  MAX_MATCH_LINE_BYTES,
} from "../src/limits.ts";
import { WorkspaceError } from "../src/errors.ts";
import { resolveRipgrepPath } from "../src/rg-binary.ts";

export type Input = ActionInput<"search.rg">;
export type Output = ActionOutput<"search.rg">;

export default defineAction<Input, Output>(async (input, ctx) => {
  const workspaceRoot = ctx.config.get<string>("WORKSPACE_ROOT", process.cwd());
  const pathPolicy = new WorkspacePathPolicy(workspaceRoot);

  // Validate candidate paths (Section 20 & 21)
  const resolvedPaths: string[] = [];
  const candidatePaths = Array.isArray(input.paths)
    ? input.paths
    : typeof input.paths === "string"
    ? [input.paths]
    : [];
  for (const p of candidatePaths) {
    const res = pathPolicy.resolveAndValidate(p);
    resolvedPaths.push(res.relativePath);
  }

  const args = buildRgArgs(input, resolvedPaths);

  const effectiveMaxColumns =
    input.maxColumns !== undefined
      ? Math.min(input.maxColumns, MAX_MATCH_LINE_BYTES)
      : MAX_MATCH_LINE_BYTES;

  const effectiveMaxResults =
    input.maxResults !== undefined
      ? Math.min(Math.max(1, Math.floor(input.maxResults)), MAX_SEARCH_RESULTS)
      : MAX_SEARCH_RESULTS;

  const beforeContext = input.beforeContext ?? input.context;
  const afterContext = input.afterContext ?? input.context;

  const parser = new RgJsonStreamParser({
    pathPolicy,
    maxResults: effectiveMaxResults,
    maxColumns: effectiveMaxColumns,
    ...(beforeContext !== undefined ? { beforeContext } : {}),
    ...(afterContext !== undefined ? { afterContext } : {}),
  });

  ctx.log.info(`Executing ripgrep search in ${pathPolicy.root}`);

  const started = await ctx.process.start(
    {
      requestId: `rg-${ctx.run.id}`,
      spec: {
        executable: resolveRipgrepPath(),
        args,
        cwd: pathPolicy.root,
        io: { mode: "pipe" },
      },
      limits: {
        idleMs: RG_TIMEOUT_MS,
        lifetimeMs: RG_TIMEOUT_MS,
        outputBufferBytes: MAX_SEARCH_OUTPUT_BYTES,
      },
    },
    { signal: ctx.signal }
  );

  let currentCursor = started.initialCursor;
  let truncated = false;
  let stderrText = "";
  let totalBytesRead = 0;
  const stdoutDecoder = createIncrementalTextDecoder();
  const stderrDecoder = createIncrementalTextDecoder();

  while (true) {
    if (ctx.signal.aborted) {
      await ctx.process.stop(started.process.id, {
        requestId: `stop-${ctx.run.id}`,
        graceMs: 500,
      });
      throw new Error("Search aborted by caller");
    }

    const readResult = await ctx.process.read(
      started.process.id,
      {
        cursor: currentCursor,
        maxBytes: 64 * 1024,
        waitMs: 1000,
        onGap: "skip",
      },
      { signal: ctx.signal }
    );

    currentCursor = readResult.nextCursor;

    for (const chunk of readResult.chunks) {
      const chunkBytes = decodeBytes(chunk.data);
      const chunkText =
        chunk.stream === "stderr"
          ? stderrDecoder.decode(chunk.stream, chunkBytes)
          : stdoutDecoder.decode(chunk.stream, chunkBytes);
      totalBytesRead += chunkBytes.byteLength;

      if (chunk.stream === "stdout") {
        const hitLimit = parser.feed(chunkText);
        if (hitLimit) {
          truncated = true;
          await ctx.process.stop(started.process.id, {
            requestId: `stop-${ctx.run.id}`,
            graceMs: 500,
          });
          break;
        }
      } else if (chunk.stream === "stderr") {
        stderrText += chunkText;
      }
    }

    if (truncated) {
      break;
    }

    if (totalBytesRead >= MAX_SEARCH_OUTPUT_BYTES) {
      truncated = true;
      await ctx.process.stop(started.process.id, {
        requestId: `stop-${ctx.run.id}`,
        graceMs: 500,
      });
      break;
    }

    if (readResult.eof) {
      // 进程被超时或外部信号终止（exit.code 为 null）时，已收集的只是部分结果，必须标记截断
      const exitCode = readResult.process.exit?.code;
      const exitSignal = readResult.process.exit?.signal;
      if (exitSignal && exitCode === null) {
        truncated = true;
      }
      // 0 = matches found, 1 = no matches found, 2 = error (Section 17)
      if (
        exitCode !== null &&
        exitCode !== undefined &&
        exitCode !== 0 &&
        exitCode !== 1
      ) {
        throw new WorkspaceError(
          stderrText.trim() || `ripgrep exited with code ${exitCode}`,
          "SEARCH_FAILED",
          500
        );
      }
      break;
    }
  }

  parser.flush();

  return {
    matches: parser.getResults(),
    truncated,
  };
});
