/**
 * Prevents agent ping-pong: every agent we start gets OC_MCP_DEPTH incremented,
 * and a bridge started inside such an agent refuses to forward further.
 */
const MAX_DEPTH = intEnv("OC_MCP_MAX_DEPTH", 1);

export const depth = intEnv("OC_MCP_DEPTH", 0);

/** A non-numeric value would make every depth comparison false and silently disable the guard. */
function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return process.env[name] && Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function assertCanForward(): void {
  if (depth >= MAX_DEPTH) {
    throw new Error(
      `oc-mcp: refusing to forward (nesting depth ${depth} >= ${MAX_DEPTH}). ` +
        "You were started by the other agent. Answer it directly instead of calling it back.",
    );
  }
}

export function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, OC_MCP_DEPTH: String(depth + 1) };
}
