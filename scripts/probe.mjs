// Dev helper: node scripts/probe.mjs <opencode|claude> <cwd> tool='{json}' ...  ($SID = last session_id)
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [target, cwd, ...calls] = process.argv.slice(2);
const c = new Client({ name: "probe", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "--target", target, "--cwd", cwd, ...(process.env.OPENCODE_URL ? ["--url", process.env.OPENCODE_URL] : [])], env: { ...process.env } }));
console.log("tools:", (await c.listTools()).tools.map((t) => t.name).join(", "));
const ctx = {};
for (const call of calls) {
  let [name, json] = call.split(/=(.*)/s);
  json = (json ?? "{}").replace(/\$SID/g, ctx.sid ?? "");
  const r = await c.callTool({ name, arguments: JSON.parse(json) }, undefined, { timeout: 900000 });
  const t = r.content.map((x) => x.text).join("\n");
  const m = t.match(/session_id: (\S+)/); if (m) ctx.sid = m[1];
  console.log(`\n=== ${name}${r.isError ? " (ERROR)" : ""}\n${t}`);
}
await c.close();
