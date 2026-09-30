export interface PipelineOptions {
  profile?: string;
  dispatchCmd?: string;
  timeout?: number;
  interval?: number;
  dryRun?: boolean;
  only?: string | null;
  skipSystemKnowledge?: boolean;
  forceSystemKnowledge?: boolean;
  syncSystemKnowledge?: boolean;
  skipInbox?: boolean;
  reportFile?: string | null;
  logFile?: string | null;
}

export interface DryRunItem {
  repo: string;
  path: string;
  repoType: string;
  renderedCommand: string;
  placeholders: Record<string, any>;
}

export interface DryRunResult {
  dryRun: true;
  total: number;
  skipped: number;
  pending: number;
  dryRunOutput: DryRunItem[];
  inboxTotal?: number;
  inboxCompleted?: number;
  inboxFailed?: number;
  inboxSkipped?: boolean;
  inboxResults?: InboxCandidateResult[];
}

export interface RepoScanItem {
  repo?: string;
  path?: string;
  repoType?: "code" | "system_knowledge" | "inbox";
  branch?: string;
  sourceBranch?: string;
  status?: string;
  hasChanges?: boolean;
  from?: string | null;
  to?: string;
  commits?: Array<{
    hash: string;
    shortHash: string;
    message: string;
    author?: string;
    date?: string;
  }>;
  changedFilesSummary?: any;
  [key: string]: any;
}

export interface RepoResult {
  repo: string;
  path: string;
  repoType: "code" | "system_knowledge" | "inbox";
  status: "completed" | "skipped" | "failed";
  targetCommit?: string;
  durationMs: number;
  message: string;
}

export interface InboxCandidate {
  id: string;
  filename: string;
  path: string;
  status: string;
  year?: string;
  title?: string;
  domain?: string;
  tags?: string[];
  repos?: string[];
  createdAt?: string;
}

export interface InboxCandidateResult {
  id: string;
  filename: string;
  title: string;
  durationMs: number;
  status: "completed" | "failed";
  error?: string | null;
}

export interface InboxPhaseSummary {
  inboxTotal: number;
  inboxCompleted: number;
  inboxFailed: number;
  inboxSkipped: boolean;
  inboxResults: InboxCandidateResult[];
}

export interface PipelineSummary {
  profile: string;
  total: number;
  completed: number;
  skipped: number;
  failed: number;
  totalElapsedMs: number;
  results: RepoResult[];
  markdownReport: string;
  reportSaved: boolean;
  logFile?: string | null;
  dryRun?: false;
  success?: boolean;
  inboxTotal?: number;
  inboxCompleted?: number;
  inboxFailed?: number;
  inboxSkipped?: boolean;
  inboxResults?: InboxCandidateResult[];
}

export interface PipelineHooks {
  execFn?: (cmd: string) => Promise<{ stdout: string; stderr: string }>;
  dispatchFn?: ((cmd: string, placeholders?: any) => Promise<any>) | null;
  sleepFn?: (ms: number) => Promise<void>;
  onProgress?: ((stats: DashboardStats) => void) | null;
  logFn?: ((msg: string) => void) | null;
  nowFn?: () => number;
}

export interface DashboardStats {
  total: number;
  processed: number;
  skipped: number;
  completed: number;
  failed: number;
  activeRepo?: string;
  activeRepoElapsed?: number;
  totalElapsed: number;
  inboxTotal?: number;
  inboxProcessed?: number;
  inboxCompleted?: number;
  inboxFailed?: number;
  inboxSkipped?: boolean;
  activeCandidate?: string;
  activeCandidateElapsed?: number;
}

export interface MarkdownReportData {
  profile?: string;
  total?: number;
  completed?: number;
  skipped?: number;
  failed?: number;
  totalElapsedMs?: number;
  results?: RepoResult[];
  inboxTotal?: number;
  inboxCompleted?: number;
  inboxFailed?: number;
  inboxSkipped?: boolean;
  inboxResults?: InboxCandidateResult[];
}
