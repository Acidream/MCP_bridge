import type { Backend, HistoryEntry, SendArgs, SessionSummary, TurnResult } from "./backend.js";
import { sleep } from "./backend.js";
import { actionLine } from "./format.js";

const TITLE_PREFIX = "[oc-mcp] ";
const POLL_MS = 1000;

interface Part {
  type: string;
  text?: string;
  synthetic?: boolean;
  tool?: string;
  state?: { status: string; input?: unknown; title?: string; error?: string };
}
interface Message {
  info: { id: string; role: "user" | "assistant"; time: { created: number; completed?: number }; error?: { name?: string; data?: { message?: string } } };
  parts: Part[];
}
interface PermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
}

export class OpencodeBackend implements Backend {
  readonly peer = "opencode";
  private headers: Record<string, string> = { "content-type": "application/json" };

  constructor(private baseUrl: string, private cwd: string) {
    const pw = process.env.OPENCODE_SERVER_PASSWORD;
    if (pw) {
      const user = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
      this.headers.authorization = "Basic " + Buffer.from(`${user}:${pw}`).toString("base64");
    }
  }

  private async call<T>(method: string, path: string, body?: unknown, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(path, this.baseUrl);
    url.searchParams.set("directory", this.cwd);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetch(url, { method, headers: this.headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new Error(`Cannot reach opencode server at ${this.baseUrl} (start it with \`opencode serve\`): ${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`opencode ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private body(args: SendArgs) {
    const b: Record<string, unknown> = {
      agent: args.agent ?? (args.mode === "review" ? "plan" : "build"),
      parts: [{ type: "text", text: args.message }],
    };
    if (args.model) {
      const i = args.model.indexOf("/");
      if (i < 1) throw new Error(`model must be "providerID/modelID", got "${args.model}"`);
      b.model = { providerID: args.model.slice(0, i), modelID: args.model.slice(i + 1) };
    }
    return b;
  }

  async start(title: string | undefined, args: SendArgs): Promise<TurnResult> {
    await this.checkModel(args.model);
    const session = await this.call<{ id: string }>("POST", "/session", {
      title: TITLE_PREFIX + (title ?? args.message.slice(0, 60)),
    });
    return this.reply(session.id, args);
  }

  /** prompt_async swallows unknown-model errors, so check up front. */
  private async checkModel(model: string | undefined): Promise<void> {
    if (!model) return;
    const { providers } = await this.call<{ providers: { id: string; models: Record<string, unknown> }[] }>("GET", "/config/providers");
    const i = model.indexOf("/");
    const p = providers.find((x) => x.id === model.slice(0, i));
    if (!p) throw new Error(`unknown provider in "${model}"; available: ${providers.map((x) => x.id).join(", ")}`);
    if (!(model.slice(i + 1) in p.models)) throw new Error(`unknown model "${model}"; see list_models_agents`);
  }

  async reply(sessionId: string, args: SendArgs): Promise<TurnResult> {
    if (await this.isBusy(sessionId)) {
      throw new Error(`opencode session ${sessionId} is still busy; use check_status or abort first`);
    }
    await this.checkModel(args.model);
    await this.call("POST", `/session/${sessionId}/prompt_async`, this.body(args));
    if (!args.wait) return { sessionId, status: "running" };
    return this.status(sessionId, args.timeoutS, true);
  }

  private async isBusy(sessionId: string): Promise<boolean> {
    const all = await this.call<Record<string, { type: string }>>("GET", "/session/status");
    const s = all[sessionId];
    return !!s && s.type !== "idle";
  }

  private async pendingPermissions(sessionId: string): Promise<PermissionRequest[]> {
    const children = await this.call<{ id: string }[]>("GET", `/session/${sessionId}/children`).catch(() => []);
    const ids = new Set([sessionId, ...children.map((c) => c.id)]);
    const all = await this.call<PermissionRequest[]>("GET", "/permission");
    return all.filter((p) => ids.has(p.sessionID));
  }

  async status(sessionId: string, waitS: number, justSent = false): Promise<TurnResult> {
    const deadline = Date.now() + waitS * 1000;
    // Right after prompt_async the session may not be marked busy yet.
    let graceUntil = justSent ? Date.now() + 5000 : 0;
    for (;;) {
      const perms = await this.pendingPermissions(sessionId);
      if (perms.length) {
        return {
          ...(await this.lastTurn(sessionId)),
          status: "needs_permission",
          permissions: perms.map((p) => ({ id: p.id, permission: p.permission, patterns: p.patterns })),
        };
      }
      const busy = await this.isBusy(sessionId);
      if (!busy) {
        const turn = await this.lastTurn(sessionId);
        if (turn.status === "done" || turn.status === "error") return turn;
        if (Date.now() > graceUntil) {
          // Idle with no assistant reply: opencode rejected the prompt (bad model/provider/config).
          return { sessionId, status: "error", text: "opencode went idle without replying; check the model/provider config and opencode logs." };
        }
      } else {
        graceUntil = 0;
      }
      if (Date.now() >= deadline) return { ...(await this.lastTurn(sessionId)), status: "running" };
      await sleep(POLL_MS);
    }
  }

  /** Collects everything the assistant produced since the last user message. */
  private async lastTurn(sessionId: string): Promise<TurnResult> {
    const msgs = await this.call<Message[]>("GET", `/session/${sessionId}/message`);
    let i = msgs.length - 1;
    while (i >= 0 && msgs[i].info.role !== "user") i--;
    const replies = msgs.slice(i + 1);
    if (!replies.length) return { sessionId, status: "running" };
    const actions: string[] = [];
    for (const m of replies) for (const p of m.parts) {
      if (p.type === "tool" && p.tool && p.state) {
        actions.push(actionLine(p.tool, p.state.input, p.state.title, p.state.status === "error" ? p.state.error : undefined));
      }
    }
    const last = replies[replies.length - 1];
    const text = textOf(last.parts);
    if (last.info.error) {
      const err = last.info.error;
      return { sessionId, status: "error", actions, text: `${err.name ?? "Error"}: ${err.data?.message ?? ""}\n${text}`.trim() };
    }
    return { sessionId, status: last.info.time.completed ? "done" : "running", actions, text };
  }

  async history(sessionId: string, limit: number): Promise<HistoryEntry[]> {
    const msgs = await this.call<Message[]>("GET", `/session/${sessionId}/message`);
    return msgs.slice(-limit).map((m) => ({
      role: m.info.role,
      text: textOf(m.parts),
      actions: m.parts
        .filter((p) => p.type === "tool" && p.tool && p.state)
        .map((p) => actionLine(p.tool!, p.state!.input, p.state!.title)),
    }));
  }

  async list(): Promise<SessionSummary[]> {
    const sessions = await this.call<{ id: string; title: string; time: { updated: number } }[]>("GET", "/session");
    const statuses = await this.call<Record<string, { type: string }>>("GET", "/session/status");
    return sessions
      .filter((s) => s.title.startsWith(TITLE_PREFIX))
      .sort((a, b) => b.time.updated - a.time.updated)
      .slice(0, 30)
      .map((s) => ({
        sessionId: s.id,
        title: s.title.slice(TITLE_PREFIX.length),
        updated: new Date(s.time.updated).toISOString(),
        status: statuses[s.id]?.type ?? "idle",
      }));
  }

  async abort(sessionId: string): Promise<void> {
    await this.call("POST", `/session/${sessionId}/abort`);
  }

  async respondPermission(permissionId: string, response: "once" | "always" | "reject", message?: string): Promise<void> {
    await this.call("POST", `/permission/${permissionId}/reply`, { reply: response, message });
  }

  async catalog(provider?: string): Promise<unknown> {
    const agents = await this.call<{ name: string; mode: string; description?: string; hidden?: boolean }[]>("GET", "/agent");
    const providers = await this.call<{ providers: { id: string; models: Record<string, unknown> }[]; default: Record<string, string> }>(
      "GET",
      "/config/providers",
    );
    return {
      agents: agents.filter((a) => !a.hidden && a.mode !== "subagent").map((a) => ({ name: a.name, description: a.description })),
      models: providers.providers.map((p) =>
        !provider || p.id === provider
          ? { provider: p.id, models: Object.keys(p.models).map((m) => `${p.id}/${m}`) }
          : { provider: p.id, count: Object.keys(p.models).length, hint: `pass provider="${p.id}" to list` },
      ),
      defaults: providers.default,
      modes: { review: "agent plan (read-only)", delegate: "agent build (can edit)" },
    };
  }
}

function textOf(parts: Part[]): string {
  const pick = (type: string) =>
    parts
      .filter((p) => p.type === type && !p.synthetic && p.text?.trim())
      .map((p) => p.text!.trim())
      .join("\n\n");
  // Some local models (e.g. qwen) put the whole answer in reasoning and emit no text part.
  return pick("text") || pick("reasoning");
}
