const MAX_ARG = 80;

function clip(s: string, n = MAX_ARG): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= n) return one;
  // For paths the tail (file name) matters most.
  return /^([a-zA-Z]:)?[\\/]/.test(one) ? "…" + one.slice(-(n - 1)) : one.slice(0, n - 1) + "…";
}

/** Pick the most telling field of a tool input for a one-line summary. */
export function describeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const k of ["filePath", "file_path", "path", "command", "pattern", "url", "description", "query"]) {
    if (typeof o[k] === "string") return clip(o[k] as string);
  }
  return clip(JSON.stringify(o));
}

export function actionLine(tool: string, input: unknown, title?: string, failed?: string): string {
  const what = title ? clip(title) : describeInput(input);
  return `${tool}${what ? " " + what : ""}${failed ? ` [failed: ${clip(failed, 60)}]` : ""}`;
}

/** Render a turn result as compact text for the calling agent. */
export function renderTurn(r: {
  sessionId: string;
  status: string;
  text?: string;
  actions?: string[];
  permissions?: { id: string; permission: string; patterns: string[] }[];
}, peer: string): string {
  const out: string[] = [`session_id: ${r.sessionId}`, `status: ${r.status}`];
  if (r.actions?.length) out.push(`${peer} actions:\n` + r.actions.map((a) => `- ${a}`).join("\n"));
  if (r.permissions?.length) {
    out.push(
      "pending permissions (answer with respond_permission):\n" +
        r.permissions.map((p) => `- ${p.id}: ${p.permission} ${p.patterns.join(", ")}`).join("\n"),
    );
  }
  if (r.status === "running") out.push(`${peer} is still working; call check_status to wait for the result.`);
  if (r.text) out.push(`${peer} says:\n${r.text}`);
  return out.join("\n\n");
}
