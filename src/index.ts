#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Backend, SendArgs } from "./backend.js";
import { ClaudeBackend } from "./claude-backend.js";
import { OpencodeBackend } from "./opencode-backend.js";
import { assertCanForward } from "./guard.js";
import { renderTurn } from "./format.js";

const { values: opts } = parseArgs({
  options: {
    target: { type: "string" },
    cwd: { type: "string" },
    url: { type: "string" },
  },
});

const cwd = resolve(opts.cwd ?? process.cwd());
let backend: Backend;
if (opts.target === "opencode") {
  backend = new OpencodeBackend(opts.url ?? process.env.OPENCODE_URL ?? "http://127.0.0.1:4096", cwd);
} else if (opts.target === "claude") {
  backend = new ClaudeBackend(cwd);
} else {
  console.error("usage: oc-mcp --target opencode|claude [--cwd DIR] [--url http://127.0.0.1:4096]");
  process.exit(2);
}

const peer = backend.peer;
const server = new McpServer({ name: `oc-mcp-${peer}`, version: "0.1.0" });

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const safe =
  <A>(fn: (a: A) => Promise<string>) =>
  async (a: A) => {
    try {
      return text(await fn(a));
    } catch (e) {
      return { ...text(`error: ${(e as Error).message}`), isError: true };
    }
  };

const sendShape = {
  message: z.string().describe(`What to say to ${peer}. Give full context: it cannot see your conversation.`),
  mode: z
    .enum(["review", "delegate"])
    .default("review")
    .describe("review = read-only discussion/opinion; delegate = it may edit files and run tools"),
  agent: z.string().optional().describe(`Override the ${peer} agent (see list_models_agents)`),
  model: z.string().optional().describe(`Override the ${peer} model (see list_models_agents)`),
  wait: z.boolean().default(true).describe("Wait for the answer. false = return immediately, then use check_status"),
  timeout_s: z.number().int().min(1).max(3600).default(300).describe("Max seconds to wait before returning status=running"),
};

type SendInput = { message: string; mode: "review" | "delegate"; agent?: string; model?: string; wait: boolean; timeout_s: number };
const toArgs = (a: SendInput): SendArgs => ({
  message: a.message,
  mode: a.mode,
  agent: a.agent,
  model: a.model,
  wait: a.wait,
  timeoutS: a.timeout_s,
});

server.registerTool(
  "start_discussion",
  {
    description: `Start a new conversation with ${peer} (another coding agent working in ${cwd}) to discuss a task, get a review/second opinion, or delegate work. Returns its answer and a session_id for follow-ups.`,
    inputSchema: { title: z.string().optional().describe("Short title for the session"), ...sendShape },
  },
  safe(async (a: SendInput & { title?: string }) => {
    assertCanForward();
    return renderTurn(await backend.start(a.title, toArgs(a)), peer);
  }),
);

server.registerTool(
  "reply",
  {
    description: `Send a follow-up message in an existing ${peer} session (multi-turn discussion).`,
    inputSchema: { session_id: z.string(), ...sendShape },
  },
  safe(async (a: SendInput & { session_id: string }) => {
    assertCanForward();
    return renderTurn(await backend.reply(a.session_id, toArgs(a)), peer);
  }),
);

server.registerTool(
  "check_status",
  {
    description: `Wait for / fetch the result of a running ${peer} turn (after wait=false or a timeout).`,
    inputSchema: { session_id: z.string(), wait_s: z.number().int().min(0).max(3600).default(120) },
  },
  safe(async (a: { session_id: string; wait_s: number }) => renderTurn(await backend.status(a.session_id, a.wait_s), peer)),
);

server.registerTool(
  "get_history",
  {
    description: `Read the transcript of a ${peer} session.`,
    inputSchema: { session_id: z.string(), limit: z.number().int().min(1).max(200).default(20) },
  },
  safe(async (a: { session_id: string; limit: number }) => {
    const h = await backend.history(a.session_id, a.limit);
    return h
      .map((m) => `### ${m.role}\n${m.actions?.length ? m.actions.map((x) => `- ${x}`).join("\n") + "\n" : ""}${m.text}`)
      .join("\n\n") || "(empty)";
  }),
);

server.registerTool(
  "list_sessions",
  { description: `List discussions with ${peer} started through this bridge.` },
  safe(async () => {
    const l = await backend.list();
    return l.map((s) => `${s.sessionId}  [${s.status}]  ${s.updated}  ${s.title}`).join("\n") || "(none)";
  }),
);

server.registerTool(
  "abort",
  { description: `Stop a running ${peer} turn.`, inputSchema: { session_id: z.string() } },
  safe(async (a: { session_id: string }) => {
    await backend.abort(a.session_id);
    return `aborted ${a.session_id}`;
  }),
);

server.registerTool(
  "list_models_agents",
  {
    description: `List the agents, models and modes ${peer} accepts.`,
    inputSchema: { provider: z.string().optional().describe("Only expand models of this provider (opencode)") },
  },
  safe(async (a: { provider?: string }) => JSON.stringify(await backend.catalog(a.provider), null, 2)),
);

if (backend.respondPermission) {
  const respond = backend.respondPermission.bind(backend);
  server.registerTool(
    "respond_permission",
    {
      description: `Answer a pending ${peer} permission request (status=needs_permission). Then call check_status.`,
      inputSchema: {
        permission_id: z.string(),
        response: z.enum(["once", "always", "reject"]),
        message: z.string().optional().describe("Optional explanation, e.g. why it was rejected"),
      },
    },
    safe(async (a: { permission_id: string; response: "once" | "always" | "reject"; message?: string }) => {
      await respond(a.permission_id, a.response, a.message);
      return `permission ${a.permission_id}: ${a.response}`;
    }),
  );
}

await server.connect(new StdioServerTransport());
