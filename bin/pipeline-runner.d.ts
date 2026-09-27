export interface RunnerOptions {
  profile: string;
  dispatchCmd: string;
  timeout: number;
  interval: number;
  dryRun: boolean;
  only: string | null;
  reportFile: string;
  help: boolean;
}

export interface Placeholders {
  repo: string;
  path: string;
  branch: string;
  from: string;
  to: string;
  commitCount: number;
  changedFilesCount: number;
  diffSummary: string;
  commitsSummary: string;
  prompt: string;
  [key: string]: unknown;
}

export interface DashboardStats {
  total: number;
  processed: number;
  skipped: number;
  completed: number;
  failed: number;
  activeRepo?: string;
  activeRepoElapsed?: number;
  totalElapsed?: number;
}

export interface RepoResult {
  repo: string;
  path: string;
  status: "completed" | "skipped" | "failed";
  targetCommit?: string;
  durationMs?: number;
  message?: string;
}

export interface PipelineSummary {
  profile: string;
  total: number;
  completed: number;
  skipped: number;
  failed: number;
  totalElapsedMs: number;
  results: RepoResult[];
  markdownReport?: string;
  reportSaved?: boolean;
}

export interface DryRunOutputItem {
  repo: string;
  path: string;
  renderedCommand: string;
  placeholders: Placeholders;
}

export interface DryRunResult {
  dryRun: true;
  total: number;
  skipped: number;
  pending: number;
  dryRunOutput: DryRunOutputItem[];
}

export function parseArgs(argv?: string[]): RunnerOptions;

export function escapeQuotes(val: unknown): string;

export function formatDuration(ms?: number): string;

export function renderProgressBar(current?: number, total?: number, width?: number): string;

export function renderDashboard(stats: DashboardStats): string;

export function buildPrompt(data: Partial<Placeholders>): string;

export function buildPlaceholders(item?: any): Placeholders;

export function renderTemplate(
  template?: string,
  vars?: Record<string, unknown> | Placeholders,
  options?: { escapeQuotes?: boolean }
): string;

export function isRepoCompleted(statusResult: any, targetCommit?: string): boolean;

export function defaultExec(cmd: string): Promise<{ stdout: string; stderr: string }>;

export function queryRemoteList(
  profile?: string,
  repoPath?: string | null,
  execFn?: (cmd: string) => Promise<{ stdout: string; stderr: string }>
): Promise<any>;

export function triggerDispatch(
  command: string,
  options?: {
    timeoutMs?: number;
    execFn?: ((cmd: string) => Promise<any> | any) | null;
  }
): Promise<{ pid?: number; output: string; exited: boolean }>;

export function generateMarkdownReport(reportData?: Partial<PipelineSummary>): string;

export function printHelp(): void;

export function runPipeline(
  options: Partial<RunnerOptions>,
  hooks?: {
    execFn?: (cmd: string) => Promise<{ stdout: string; stderr: string }>;
    dispatchFn?: ((cmd: string, placeholders: Placeholders) => Promise<any> | any) | null;
    sleepFn?: (ms: number) => Promise<void>;
    onProgress?: ((stats: DashboardStats) => void) | null;
    /** 可注入的时钟函数，测试用虚拟时钟驱动，缺省为 Date.now */
    nowFn?: () => number;
  }
): Promise<PipelineSummary | DryRunResult>;

export function main(argv?: string[]): Promise<void>;
