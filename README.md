# VoidCode

A terminal **and** desktop AI coding agent harness. OpenCode-style: it runs in
your project, reads your files, edits them with your permission, runs commands,
spawns sub-agents, and remembers everything across sessions.

- **Small native engine** — the core uses Node built-ins plus the SQLite runtime
  used by the optional SQL-backed execution context. No application build step is
  required. Every file is editable.
- **Two front-ends, one brain** — a terminal REPL and an Electron desktop app
  share the same agent loop, tools, sessions, permissions, and scheduler.
- **Any OpenAI-compatible provider** — OpenRouter, OpenAI, local Ollama, a
  llama.cpp server, or a custom endpoint.

```text
voidcode                        interactive REPL in the current project
voidcode -c                     continue the most recent session here
voidcode --resume <id>          resume a specific session
voidcode -p "prompt"            non-interactive: run one prompt, print, exit
voidcode -m ollama/llama3.1     override model for this run
npm run app                     desktop app (Electron)
```

## Quick start

1. **Node.js 20+** is required.
2. `npm start` (or `voidcode` once installed globally with
   `npm link`/`npm i -g .`). On first launch it asks for your OpenRouter API
   key — input is masked, and it's saved to `~/.voidcode/config.json`. The
   `OPENROUTER_API_KEY` environment variable works too.
3. Local models need no key: `/model ollama/llama3.1` picks an installed Ollama
   model, `llamacpp/default` uses whatever GGUF your llama.cpp server loaded.
   Any OpenAI-compatible endpoint can be added under `providers`.
4. Change keys, provider, model, permissions, bash allowlist, persona, memory,
   and autonomy level anytime with `/settings` (terminal) or the Settings modal
   (desktop).

On Windows, `installer.ps1` gives you a GUI installer (checks/installs Node,
runs `npm install`, launches); `launch.bat` just runs the desktop app.

## What the harness does

- **Agent loop** — streaming responses, parallel-safe tool-call accumulation,
  up to 100 tool rounds per turn, automatic retry on transient network errors
  (with backoff), Ctrl+C interrupts mid-generation.
- **Tools** — `bash` (PowerShell or bash, working directory persists across
  calls), `read`, `write`, `edit` (exact-string replace, uniqueness-enforced,
  rendered as a colored diff), `ls`, `glob`, `grep`, `webfetch`, `todowrite`
  (plan rendering), `project_memory` (persistent `.voidcode-memory.md`),
  `schedule` (agent-managed calendar), `cost_tracker` (USD/time reporting),
  `context_query` (structured SQL-backed execution context), `task` (inline subagents with their own context).
- **Sessions** — every conversation persists under `~/.voidcode/projects/`;
  list with `/sessions`, resume with `/resume` or `-c`. `/undo` reverts the
  last file change (full before-snapshots kept per session, capped at 50).
  `/diff` shows every change this session.
- **Context management** — a durable roadmap (`todowrite`, grouped into
  phases) and the original task are pinned outside the conversation history
  and re-injected into every system prompt, so they survive regardless of
  what happens to older messages. When the estimated window passes 75% (or
  90% mid-turn), the OLDEST chunk of history is retired incrementally —
  never the recent exchanges — with roadmap progress and durable facts
  extracted into the roadmap/`project_memory` before the chunk is replaced
  by a short pointer, plus manual `/compact`.
- **Permissions** — per-category modes (`allow`/`ask`/`deny`) for
  bash / write / edit / webfetch / mcp; `bashAllow` patterns (e.g. `"git *"`)
  skip prompts. Interactive prompts offer once / always-this-session / deny.
  Non-interactive runs auto-deny anything gated. Autonomy levels
  (`off`/`research`/`safe`/`full`) auto-allow read-only or safe actions and are
  described to the agent in the system prompt.
- **MCP** — stdio Model Context Protocol servers via config; their tools are
  exposed to the model as `mcp_<server>_<tool>`:

```json
{
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\data"] }
  }
}
```

- **Project instructions** — `AGENTS.md`, `CLAUDE.md`, and `.voidcode.md` in
  the project root are injected into the system prompt. `/init` analyzes the
  project and writes one.
- **Hardened ruleset** — a prompt-injection-defense ruleset (`rules/`) is
  loaded into every system prompt above project instructions. Always-on core
  (instruction hierarchy, data-is-never-instructions, tool hygiene) plus an
  on-demand Tier-1 set (context/security/governance/coding/accessibility/
  engineering). Context-aware: small local-model windows get a distilled core
  so 8k Ollama stays usable; deep modules are read on demand per
  `rules/09-RULE-INDEX.md`.
- **Focus agents** — background autonomous sub-agents with time budgets
  (`focus` tool, default 30 min) that work in isolation, can pause to ask you a
  question (`focus_pause` → answer via `/focus answer <id> "..."` or the
  `focus_answer` tool), and coordinate through a shared message board. Track
  them with `/focus list`.
- **Scheduled tasks** — the agent manages its own calendar (cron or "every N
  minutes") through the `schedule` tool. A background scheduler polls every 30 s
  and runs due tasks at their autonomy level. Check status with `/scheduler`
  or the desktop Schedule tab.
- **Live model catalog** — never a hardcoded list. `discoverModels` merges your
  stored `models.json` with OpenRouter's live catalog and the models actually
  installed in Ollama / llama.cpp on this machine. The agent can query it
  (`list_models`), switch its own model (`set_model`), and route roles or
  specific sub-agents to models (`assign_model`, `agent_structure`) — the main
  agent's model and sub-agent models are fully independent. CLI:
  `/models [query]`, `/models set <id>`.
- **Web portal (optional)** — a zero-dependency HTTP panel with an SSE event
  stream for remote control of VoidCode (e.g. from a phone), optionally exposed
  over a Cloudflare quick tunnel for public access. See `app/portal.js`.

## Slash commands

`/help` `/settings` `/new` `/sessions` `/resume` `/delete` `/model` `/models`
`/compact` `/undo` `/diff` `/tools` `/mcp` `/usage` `/context` `/init`
`/scheduler` `/research` `/focus` `/clear` `/exit`

## Desktop app

```text
npm run app        # or: launch.bat
```

The Electron app wraps the same engine in a dark, quiet UI:

- Chat with streaming markdown, tool cards, live diffs, and a plan pane.
- **Compose by voice**: push-to-talk (`Ctrl+Space`), hands-free open-mic
  conversation with voice-activity detection and barge-in, and spoken replies
  (STT via any OpenAI-compatible transcriptions endpoint — Groq's free whisper
  tier works out of the box; TTS falls back Edge neural → Windows SAPI, with
  Fish Audio optional).
- **Analyze screenshots and images**: use the image button to attach PNG, JPEG,
  WebP, or GIF files, or paste a screenshot directly into the composer. The
  desktop identifies OpenRouter models that advertise image input, sends the
  attachment as standard multimodal `image_url` content, and preserves it in
  session history. Up to 4 images are accepted per message, 10 MB each.
- Right panel with **Review** (files changed, original vs current),
  **Plan** (todos), **Schedule** (create/toggle/remove timed tasks), and
  **Focus** (background agents).
- Session management, a settings modal (API keys, model, permissions, persona,
  memory, voice), and a model picker fed by the live catalog with a full
  agent→model structure view.

## Per-project config

Create a `.voidcode.json` in any project to override global settings — same
keys, deep-merged:

```json
{
  "provider": "openrouter",
  "model": "anthropic/claude-sonnet-4.5",
  "permissions": { "bash": "ask", "write": "allow" },
  "contextTokens": 200000,
  "compactAt": 0.75,
  "maxToolRounds": 100
}
```

## Config precedence

```text
defaults ← ~/.voidcode/config.json ← <project>/.voidcode.json
```

Useful keys: `provider`, `model`, `smallModel` (cheaper model for compaction),
`interactionStyle` (`collaborative` | `direct`), `persona`, `memory`,
`permissions`, `bashAllow`, `contextTokens`, `compactAt`, `maxToolRounds`,
`autonomyLevel`, `protectedPaths`, `mcpServers`, `voice`.

## More documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — full architecture and
  reference: every module, the agent loop, configuration, tools, permissions,
  autonomy levels, sessions/undo, cost tracking, context management, focus
  agents, schedules, MCP, the desktop IPC surface, the live model catalog,
  installer, testing, and how to extend VoidCode.

## Extending it

There is no build step and no dependency tree — the harness is ~30 small files.
Add a tool: create `defs` + executor in `src/tools/`, register it in
`src/tools/index.js` (use `includeFocus`/`includeModel` for contextual tools).
Test: `npm test` runs an end-to-end scripted-provider suite that exercises the
loop, editing, bash, and session persistence with no API key.

```
bin/voidcode.js          CLI entry
src/index.js             terminal REPL, slash commands, rendering wiring
src/agent.js             the loop: rounds, permissions, compaction, subagents
src/providers.js         OpenAI-compatible streaming client (all providers)
src/prompt.js            system prompt (env, git, instructions, memory)
src/config.js            merged config + provider resolution + model registry
src/tools/*.js           tool definitions + executors
src/permissions.js       allow/ask/deny + autonomy levels
src/sessions.js          persistence, undo snapshots
src/costTracker.js       project cost/time aggregates
src/schedule.js, src/scheduler.js   task store + background runner
src/focus.js             background focus agents + message board
src/agentRoles.js        role/agent → model assignments
src/modelCatalog.js      live model discovery (OpenRouter + Ollama + llama.cpp)
src/mcp.js               stdio MCP client
src/guardrails.js        universal turn interceptor + behavioral learning memory
src/rules.js             hardened ruleset loader (progressive Tier-1 disclosure)
src/contextDb.js         SQL-backed execution context (sql.js, topic collections)
src/continuationPacket.js  structured continuation packets after tool calls
src/organism.js          optional digital-organism treasury layer
src/ui.js                ANSI markdown, diffs, spinner
app/                     Electron desktop app (main, preload, renderer/, voice)
app/portal.js            zero-dependency web control panel + SSE stream (mobile)
app/portalWeb/           web portal front-end (served by app/portal.js)
docs/ARCHITECTURE.md     full architecture & reference
docs/MEMORY-SERVICE.md   operator memory service design (draft, not yet shipped)
test/harness.test.js     unit + e2e tests
```