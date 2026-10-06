# oc-mcp

A two-way MCP bridge that lets **Claude Code** and **opencode** discuss tasks with each other:
multi-turn chat, read-only reviews/second opinions, and delegating work that edits the repo.

One stdio MCP server, two modes:

| Mode | Register it in | Talks to |
|---|---|---|
| `--target opencode` | Claude Code | `opencode serve` HTTP API (default `http://127.0.0.1:4096`) |
| `--target claude` | opencode | `claude -p` headless (stream-json, `--session-id` / `--resume`) |

## Tools (same in both modes)

| Tool | What it does |
|---|---|
| `start_discussion(message, title?, mode, agent?, model?, wait, timeout_s)` | New session + first message; returns the answer and `session_id` |
| `reply(session_id, message, …)` | Follow-up in the same session |
| `check_status(session_id, wait_s)` | Wait for a turn started with `wait:false` or that hit `timeout_s` |
| `get_history(session_id, limit)` | Transcript |
| `list_sessions()` | Sessions started through the bridge |
| `abort(session_id)` | Stop a running turn |
| `list_models_agents(provider?)` | Valid `agent` / `model` values |
| `respond_permission(permission_id, response)` | *(opencode mode only)* answer a pending permission request |

`mode`: `review` (default, read-only) or `delegate` (may edit files).

- opencode: review → agent `plan`, delegate → agent `build`. `model` is `provider/model`, e.g. `anthropic/claude-sonnet-4-5`.
- claude: review → `--permission-mode plan`, delegate → `--permission-mode acceptEdits`. `model` is e.g. `sonnet`, `haiku`, `opus`.

Replies are condensed: the final answer, plus one line per tool the other agent used.

## Setup

```sh
npm install
npm run build
```

### Claude Code → opencode

Start the opencode server (from any folder; the bridge passes the project directory on every request):

```sh
opencode serve            # set OPENCODE_SERVER_PASSWORD to require basic auth
```

Register the bridge (run this inside the project you want both agents to work on):

```sh
claude mcp add opencode -- node C:/projects/oc_mcp/dist/index.js --target opencode
```

Options: `--url http://host:port` (or `OPENCODE_URL`) and `--cwd DIR` (defaults to the launch directory).

### opencode → Claude Code

In `opencode.json` (global `~/.config/opencode/opencode.json` or per project):

```json
{
  "mcp": {
    "claude": {
      "type": "local",
      "command": ["node", "C:/projects/oc_mcp/dist/index.js", "--target", "claude"],
      "timeout": 600000
    }
  }
}
```

Environment variables for this mode:
- `OC_MCP_CLAUDE_ALLOWED_TOOLS`: extra tools allowed in delegate mode, separated by spaces or commas, e.g. `"Bash(npm test:*) Bash(git diff:*), Read"`. Without it, Claude can edit files but not run shell commands, because headless runs can't ask for permission.
- `OC_MCP_CLAUDE_BIN`: path to `claude` if it's not on `PATH`.

- On Windows, point `OC_MCP_CLAUDE_BIN` at a real executable (the native installer's `claude.exe`); npm's `claude.cmd` shim can't be spawned without a shell.

Claude session transcripts are stored in `~/.oc_mcp/claude-sessions/<session_id>.json` (an older `~/.oc_mcp/claude-sessions.json` is migrated automatically and kept as `.bak`).

## Notes

- **No loops:** the `claude` child process runs with `--strict-mcp-config` and no MCP servers, so it can't call opencode back. The bridge also sets `OC_MCP_DEPTH` on processes it starts and refuses to forward at depth ≥ 1 (`OC_MCP_MAX_DEPTH`).
- **Long tasks:** if a turn runs past `timeout_s`, you get `status: running`; use `check_status` to collect the result.
- **opencode permissions:** in delegate mode, opencode may stop with `status: needs_permission`. Answer with `respond_permission`, or allow the actions in opencode's `permission` config.
- **Models:** the opencode free tier (`opencode/*`) rejects headless/API use, so configure a real provider.
- **Local Ollama models:** Ollama's default context window is too small for opencode's system prompt, so the model sees a cut-off prompt and gives unrelated answers. Create a variant with a larger window (`FROM qwen3.5:9b` + `PARAMETER num_ctx 32768` → `ollama create qwen3.5:9b-32k -f Modelfile`) and use that in opencode.

## Development

```sh
npm run build
node scripts/probe.mjs opencode . list_models_agents='{"provider":"anthropic"}'
node scripts/probe.mjs claude . 'start_discussion={"message":"hi","model":"haiku"}' 'reply={"session_id":"$SID","message":"and again"}'
npx @modelcontextprotocol/inspector node dist/index.js --target opencode
```
