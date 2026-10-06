import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Backend, HistoryEntry, SendArgs, SessionSummary, TurnResult } from "./backend.js";
import { sleep } from "./backend.js";
import { actionLine } from "./format.js";
import { childEnv } from "./guard.js";

interface StoredSession {
  id: string;
  title: string;
  cwd: string;
  updated: string;
  turns: HistoryEntry[];
}

interface Job {
  proc: ChildProcess;
  actions: string[];
  text?: string;
  error?: string;
  done: boolean;
}

const STORE_DIR = join(homedir(), ".oc_mcp");
const STORE = join(STORE_DIR, "claude-sessions.json");

export class ClaudeBackend implements Backend {
  readonly peer = "claude";
  private jobs = new Map<string, Job>();

  constructor(private cwd: string, private bin = process.env.OC_MCP_CLAUDE_BIN ?? "claude") {}

  private load(): Record<string, StoredSession> {
    try {
      return JSON.parse(readFileSync(STORE, "utf8"));
    } catch {
      return {};
    }
  }

  private save(s: StoredSession): void {
    const all = this.load();
    all[s.id] = s;
    mkdirSync(STORE_DIR, { recursive: true });
    writeFileSync(STORE, JSON.stringify(all, null, 2));
  }

  async start(title: string | undefined, args: SendArgs): Promise<TurnResult> {
    const id = randomUUID();
    this.save({ id, title: title ?? args.message.slice(0, 60), cwd: this.cwd, updated: new Date().toISOString(), turns: [] });
    return this.run(id, true, args);
  }

  async reply(sessionId: string, args: SendArgs): Promise<TurnResult> {
    if (!this.load()[sessionId]) throw new Error(`Unknown claude session ${sessionId}`);
    if (this.jobs.get(sessionId)?.done === false) {
      throw new Error(`claude session ${sessionId} is still busy; use check_status or abort first`);
    }
    return this.run(sessionId, false, args);
  }

  private run(sessionId: string, fresh: boolean, args: SendArgs): Promise<TurnResult> {
    const stored = this.load()[sessionId];
    const cliArgs = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      // No MCP servers in the child: Claude cannot call back into opencode (no loops).
      "--strict-mcp-config",
      "--permission-mode", args.mode === "review" ? "plan" : "acceptEdits",
      ...(fresh ? ["--session-id", sessionId] : ["--resume", sessionId]),
    ];
    if (args.model) cliArgs.push("--model", args.model);
    if (args.agent) cliArgs.push("--agent", args.agent);
    const allowed = process.env.OC_MCP_CLAUDE_ALLOWED_TOOLS;
    if (args.mode === "delegate" && allowed) cliArgs.push("--allowedTools", ...allowed.split(/[\s,]+/).filter(Boolean));

    const proc = spawn(this.bin, cliArgs, { cwd: stored.cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const job: Job = { proc, actions: [], done: false };
    this.jobs.set(sessionId, job);

    let buf = "";
    let stderr = "";
    proc.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.onEvent(job, line);
      }
    });
    proc.stderr!.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    proc.on("error", (e) => {
      job.error = `failed to start ${this.bin}: ${e.message}`;
      job.done = true;
    });
    proc.on("close", (code) => {
      if (buf.trim()) this.onEvent(job, buf.trim());
      if (code !== 0 && !job.text && !job.error) job.error = `claude exited with code ${code}: ${stderr.slice(-800)}`;
      job.done = true;
      const s = this.load()[sessionId];
      if (s) {
        s.turns.push({ role: "assistant", text: job.text ?? job.error ?? "", actions: job.actions });
        s.updated = new Date().toISOString();
        this.save(s);
      }
    });

    stored.turns.push({ role: "user", text: args.message });
    stored.updated = new Date().toISOString();
    this.save(stored);
    proc.stdin!.end(args.message);

    if (!args.wait) return Promise.resolve({ sessionId, status: "running" });
    return this.status(sessionId, args.timeoutS);
  }

  private onEvent(job: Job, line: string): void {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      for (const c of ev.message.content) {
        if (c.type === "tool_use") job.actions.push(actionLine(c.name, c.input));
      }
    } else if (ev.type === "result") {
      if (ev.is_error) job.error = String(ev.result ?? ev.subtype ?? "error");
      else job.text = String(ev.result ?? "");
    }
  }

  async status(sessionId: string, waitS: number): Promise<TurnResult> {
    const job = this.jobs.get(sessionId);
    if (!job) {
      const last = this.load()[sessionId]?.turns.at(-1);
      if (!last) throw new Error(`Unknown claude session ${sessionId}`);
      return { sessionId, status: "done", text: last.role === "assistant" ? last.text : undefined, actions: last.actions };
    }
    const deadline = Date.now() + waitS * 1000;
    while (!job.done && Date.now() < deadline) await sleep(500);
    if (!job.done) return { sessionId, status: "running", actions: [...job.actions] };
    return { sessionId, status: job.error ? "error" : "done", text: job.error ?? job.text, actions: job.actions };
  }

  async history(sessionId: string, limit: number): Promise<HistoryEntry[]> {
    const s = this.load()[sessionId];
    if (!s) throw new Error(`Unknown claude session ${sessionId}`);
    return s.turns.slice(-limit);
  }

  async list(): Promise<SessionSummary[]> {
    return Object.values(this.load())
      .filter((s) => s.cwd === this.cwd)
      .sort((a, b) => b.updated.localeCompare(a.updated))
      .slice(0, 30)
      .map((s) => ({
        sessionId: s.id,
        title: s.title,
        updated: s.updated,
        status: this.jobs.get(s.id)?.done === false ? "busy" : "idle",
      }));
  }

  async abort(sessionId: string): Promise<void> {
    const job = this.jobs.get(sessionId);
    if (job && !job.done) {
      job.error = "aborted";
      job.proc.kill();
    }
  }

  async catalog(): Promise<unknown> {
    return {
      models: ["opus", "sonnet", "haiku", "or a full model id such as claude-opus-5-5"],
      agents: "any Claude Code agent name configured for this project (passed as --agent)",
      modes: { review: "--permission-mode plan (read-only)", delegate: "--permission-mode acceptEdits (can edit files)" },
      delegateAllowedTools: process.env.OC_MCP_CLAUDE_ALLOWED_TOOLS ?? "(none; set OC_MCP_CLAUDE_ALLOWED_TOOLS to e.g. \"Bash(npm test:*)\")",
    };
  }
}
