export type Mode = "review" | "delegate";

export interface SendArgs {
  message: string;
  mode: Mode;
  agent?: string;
  model?: string;
  /** Wait for the answer; false returns immediately with status "running". */
  wait: boolean;
  timeoutS: number;
}

export interface TurnResult {
  sessionId: string;
  status: "done" | "running" | "needs_permission" | "error";
  /** Final assistant text (or error text). */
  text?: string;
  /** One line per tool call, e.g. "edit src/a.ts". */
  actions?: string[];
  permissions?: { id: string; permission: string; patterns: string[] }[];
}

export interface HistoryEntry {
  role: "user" | "assistant";
  text: string;
  actions?: string[];
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  updated: string;
  status?: string;
}

export interface Backend {
  readonly peer: string;
  start(title: string | undefined, args: SendArgs): Promise<TurnResult>;
  reply(sessionId: string, args: SendArgs): Promise<TurnResult>;
  /** Poll a running turn; returns the latest assistant output. */
  status(sessionId: string, waitS: number): Promise<TurnResult>;
  history(sessionId: string, limit: number): Promise<HistoryEntry[]>;
  list(): Promise<SessionSummary[]>;
  abort(sessionId: string): Promise<void>;
  catalog(provider?: string): Promise<unknown>;
  respondPermission?(permissionId: string, response: "once" | "always" | "reject", message?: string): Promise<void>;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
