import type { Backend, HistoryEntry, SendArgs, SessionSummary, TurnResult } from "./backend.js";
import { sleep } from "./backend.js";
import { actionLine } from "./format.js";

const TITLE_PREFIX = "[oc-mcp] ";
const POLL_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;

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
    // Keep any path prefix of the base URL (e.g. behind a reverse proxy).
    if (!this.baseUrl.endsWith("/")) this.baseUrl += "/";
    const pw = process.env.OPENCODE_SERVER_PASSWORD;
    if (pw) {
      const user = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
      this.headers.authorization = "Basic " + Buffer.from(`${user}:${pw}`).toString("base64");
    }
  }

  private async call<T>(method: string, path: string, body?: unknown, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(path.replace(/^\//, ""), this.baseUrl);
    url.searchParams.set("directory", this.cwd);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method,
        headers: this.headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      text = await res.text();
    } catch (e) {
      if ((e as Error).name === "TimeoutError") {
        throw new Error(`opencode ${method} ${path} timed out after ${REQUEST_TIMEOUT_MS / 1000}s; is the server hung?`);
      }
      throw new Error(`Cannot reach opencode server at ${this.baseUrl} (start it with \`opencode serve\`): ${(e as Error).message}`);
    }
    if (!res.ok) throw new Error(`opencode ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private body(args: SendArgs) {
    const b: Record<string, unknown> = {
      agent: args.agent ?? (args.mode === "review" ? "plan" : "build"),
      parts: [{ type: "text", text: args.message }],
    };
    if (args.model) b.model = parseModel(args.model);
    return b;
  }

  async start(title: string | undefined, args: SendArgs): Promise<TurnResult> {
    await this.checkModel(args.model);
    const session = await this.call<{ id: string }>("POST", "/session", {
      title: TITLE_PREFIX + (title ?? args.message.slice(0, 60)),
    });
    return this.send(session.id, args, null);
  }

  /** prompt_async swallows unknown-model errors, so check up front. */
  private async checkModel(model: string | undefined): Promise<void> {
    if (!model) return;
    const { providerID, modelID } = parseModel(model);
    const { providers } = await this.call<{ providers: { id: string; models: Record<string, unknown> }[] }>("GET", "/config/providers");
    const p = providers.find((x) => x.id === providerID);
    if (!p) throw new Error(`unknown provider in "${model}"; available: ${providers.map((x) => x.id).join(", ")}`);
    if (!(modelID in p.models)) throw new Error(`unknown model "${model}"; see list_models_agents`);
  }

  async reply(sessionId: string, args: SendArgs): Promise<TurnResult> {
    if (await this.isBusy(sessionId)) {
      throw new Error(`opencode session ${sessionId} is still busy; use check_status or abort first`);
    }
    const msgs = await this.call<Message[]>("GET", `/session/${enc(sessionId)}/message`);
    return this.send(sessionId, args, lastUserId(msgs));
  }

  /** prevUserId: the last user message before this send, so its old reply isn't mistaken for the new one. */
  private async send(sessionId: string, args: SendArgs, prevUserId: string | null): Promise<TurnResult> {
    await this.checkModel(args.model);
    await this.call("POST", `/session/${enc(sessionId)}/prompt_async`, this.body(args));
    if (!args.wait) return { sessionId, status: "running" };
    return this.poll(sessionId, args.timeoutS, prevUserId);
  }

  private async isBusy(sessionId: string): Promise<boolean> {
    const all = await this.call<Record<string, { type: string }>>("GET", "/session/status");
    const s = all[sessionId];
    return !!s && s.type !== "idle";
  }

  private async pendingPermissions(sessionId: string): Promise<PermissionRequest[]> {
    const all = await this.call<PermissionRequest[]>("GET", "/permission");
    if (!all.length) return [];
    // Subagents run in child sessions, possibly nested.
    const ids = new Set([sessionId]);
    for (const queue = [sessionId]; queue.length; ) {
      const id = queue.shift()!;
      const children = await this.call<{ id: string }[]>("GET", `/session/${enc(id)}/children`).catch(() => []);
      for (const c of children) {
        if (!ids.has(c.id)) {
          ids.add(c.id);
          queue.push(c.id);
        }
      }
    }
    return all.filter((p) => ids.has(p.sessionID));
  }

  status(sessionId: string, waitS: number): Promise<TurnResult> {
    return this.poll(sessionId, waitS);
  }

  /** prevUserId is passed right after a send (null = the session had no user message yet). */
  private async poll(sessionId: string, waitS: number, prevUserId?: string | null): Promise<TurnResult> {
    const deadline = Date.now() + waitS * 1000;
    // Right after prompt_async the session may not be marked busy yet.
    let graceUntil = prevUserId !== undefined ? Date.now() + 5000 : 0;
    for (;;) {
      const perms = await this.pendingPermissions(sessionId);
      if (perms.length) {
        return {
          ...(await this.lastTurn(sessionId, prevUserId)),
          status: "needs_permission",
          permissions: perms.map((p) => ({ id: p.id, permission: p.permission, patterns: p.patterns })),
        };
      }
      const busy = await this.isBusy(sessionId);
      if (!busy) {
        const turn = await this.lastTurn(sessionId, prevUserId);
        if (turn.status === "done" || turn.status === "error") return turn;
        if (Date.now() > graceUntil) {
          // Idle with no assistant reply: opencode rejected the prompt (bad model/provider/config).
          return { sessionId, status: "error", text: "opencode went idle without replying; check the model/provider config and opencode logs." };
        }
      } else {
        graceUntil = 0;
      }
      if (Date.now() >= deadline) return { ...(await this.lastTurn(sessionId, prevUserId)), status: "running" };
      await sleep(POLL_MS);
    }
  }

  /** Collects everything the assistant produced since the last user message. */
  private async lastTurn(sessionId: string, prevUserId?: string | null): Promise<TurnResult> {
    const msgs = await this.call<Message[]>("GET", `/session/${enc(sessionId)}/message`);
    let i = msgs.length - 1;
    while (i >= 0 && msgs[i].info.role !== "user") i--;
    // The message we just sent isn't stored yet; what we see is the previous turn.
    if (prevUserId !== undefined && (msgs[i]?.info.id ?? null) === prevUserId) return { sessionId, status: "running" };
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
    const msgs = await this.call<Message[]>("GET", `/session/${enc(sessionId)}/message`);
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
    await this.call("POST", `/session/${enc(sessionId)}/abort`);
  }

  async respondPermission(permissionId: string, response: "once" | "always" | "reject", message?: string): Promise<void> {
    await this.call("POST", `/permission/${enc(permissionId)}/reply`, { reply: response, message });
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

const enc = encodeURIComponent;

function parseModel(model: string): { providerID: string; modelID: string } {
  const i = model.indexOf("/");
  if (i < 1 || i === model.length - 1) throw new Error(`model must be "providerID/modelID", got "${model}"`);
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
}

function lastUserId(msgs: Message[]): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].info.role === "user") return msgs[i].info.id;
  return null;
}
