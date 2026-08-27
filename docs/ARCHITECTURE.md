# VoidCode — Architecture & Reference

VoidCode is an AI coding agent harness with two front-ends — a terminal REPL and
an Electron desktop app — sharing one zero-dependency engine. This document
describes the whole system: what every file does, how the pieces connect, how
configuration and data flow, and how to extend and test it.

---

## 1. Overview

- **Two surfaces, one engine.** The terminal (`src/`) and the desktop app
  (`app/`) both build an `Agent` from the same modules. Only the UI and the
  wiring differ.
- **Zero runtime dependencies.** The harness core (everything under `src/`) uses
  only Node built-ins. The desktop app pulls in Electron; the optional voice
  TTS uses `msedge-tts`. There is no build step — the code runs as-is.
- **Provider-agnostic.** Any OpenAI-compatible chat endpoint works: OpenRouter,
  OpenAI, a local Ollama instance, a llama.cpp server, or a custom endpoint.
  Streaming, tool calls, and usage reporting are all handled by one client.
- **Everything inspectable and editable.** Config, sessions, models, schedules,
  agent-role assignments, and focus boards are plain JSON files under
  `~/.voidcode/` (or in the project for memory/instructions).

### Components at a glance

| Area | Location | Purpose |
| --- | --- | --- |
| CLI entry | `bin/voidcode.js` | Tiny wrapper that calls `src/index.js main()`. |
| Terminal UI | `src/index.js` | REPL, slash commands, `/settings` menu, rendering events, scheduler wiring, non-interactive `-p` mode. |
| Agent engine | `src/agent.js` | The loop: stream → tool calls → results, retries, compaction, subagents, usage accounting. |
| Streaming client | `src/providers.js` | SSE/OpenAI-compatible `streamChat` + `complete`, idle watchdog, tool-call accumulation, text-based tool-call fallback. |
| Tools | `src/tools/*.js` | Tool definitions + executors (bash, fs, search, web, todo, memory, schedule, cost, task, focus, model). |
| Permissions | `src/permissions.js` | allow/ask/deny modes + autonomy levels + bash allow patterns. |
| Sessions | `src/sessions.js` | Persistence of conversations, undo snapshots, usage per session. |
| Config | `src/config.js` | Merged config, provider resolution, project instructions, model registry. |
| MCP | `src/mcp.js` | stdio Model Context Protocol client. |
| Prompt | `src/prompt.js` | System-prompt builder: personality, environment, instructions, memory, autonomy, focus/subagent modes. |
| UI helpers | `src/ui.js` | ANSI colors, streaming markdown, LCS diffs, spinner, tool headers. |
| Cost tracker | `src/costTracker.js` | Per-project USD/token/time aggregates. |
| Focus agents | `src/focus.js` | Background autonomous sub-agents with time budgets, pause-for-question, shared message board. |
| Schedule | `src/schedule.js`, `src/scheduler.js` | Persistent task store (cron/interval) + background polling runner. |
| Model catalog | `src/modelCatalog.js` | Live model discovery: stored `models.json` + OpenRouter catalog + installed Ollama/llama.cpp models. |
| Agent roles | `src/agentRoles.js` | Persisted role → model and agent → model assignments per project directory. |
| Desktop main | `app/main.js` | Electron main process: window, IPC, agent wiring, scheduler, voice backend hooks. |
| Desktop preload | `app/preload.js` | `contextBridge` exposing the `window.vc` API (invoke + event subscriptions). |
| Desktop renderer | `app/renderer/` | `index.html`, `app.js`, `styles.css`, `md.js`, `diff.js`, `voice.js` — the full chat UI. |
| Voice backend | `app/voice.js` | STT via any OpenAI-compatible transcriptions endpoint; TTS with fish → edge → sapi fallback. |
| Tests | `test/harness.test.js` | Unit + end-to-end tests with a scripted mock provider. No API keys. |
| Installer | `installer.ps1` | PowerShell/WPF installer: checks Node, installs dependencies, launches. |
| Launcher | `launch.bat` | `npm run app`. |

---

## 2. Entry points and the agent loop

### CLI (`bin/voidcode.js` → `src/index.js`)

`main()` (in `src/index.js`):

1. Parses arguments: `-p/--print`, `-c/--continue`, `--resume <id>`, `-m/--model`, `-h/--help`, `-v/--version`.
2. Loads config for the current working directory (`config.load(cwd)`).
3. Resolves the provider (with optional model override via `config.resolveProvider`).
4. Picks a `Session` — new, most recent (`-c`), or a specific one (`--resume`).
5. Starts configured MCP servers (`mcp.startServers`).
6. Builds a `Permissions` instance whose prompt function is the REPL (in
   non-interactive mode it always returns `'n'`).
7. Constructs the `Agent` with an `events` object that drives rendering
   (`onDelta`, `onToolStart/End`, `onFileChange`, `onTodos`, `onStatus`,
   `onSubagent*`, `onFocus*`).
8. If there are enabled scheduled tasks, starts the background `Scheduler`.
9. Runs either one turn (`-p`, autonomous) or the interactive REPL.

The REPL handles slash commands (`/help`, `/settings`, `/new`, `/sessions`,
`/resume`, `/delete`, `/model`, `/models`, `/compact`, `/undo`, `/diff`,
`/tools`, `/mcp`, `/usage`, `/scheduler`, `/focus`, `/init`, `/clear`,
`/exit`). `Ctrl+C` aborts generation with `agent.stop()`; twice at an empty
prompt exits.

### The loop (`src/agent.js`)

`Agent._loop(messages, tools, opts)` is the heart:

- Up to `maxToolRounds` (config, default 100) rounds per user turn.
- Each round calls `providers.streamChat` with the system prompt + message
  history + tool definitions.
- Transient network errors (dropped connection, rate limits, 5xx) are retried
  up to 2 more times with backoff; anything else fails fast.
- If the response contains tool calls, each call is:
  1. Argument-parsed (`parseToolArgs`, which tolerates trailing commas and raw
     newlines).
  2. Permission-checked (see §5).
  3. Executed via the tools executor map; the result is appended as a `tool`
     message and the loop continues.
- When the model returns plain text (no tool calls), that text is the final
  answer. A special case nudges local models that emit an empty completion after
  a tool round with a `[continue]` message.
- Usage (`prompt_tokens`, `completion_tokens`, and OpenRouter's `total_cost`)
  is accumulated into the session; the project cost aggregate is rebuilt after
  every turn.
- The abort controller is saved/restored around each loop so subagents never
  clobber the main agent's interrupt state.

`Agent.send()` appends the user message, sets the session title on first turn,
auto-compacts if the estimated context exceeds the threshold, runs the loop, and
saves the session.

### Desktop (`app/main.js`)

The Electron main process reuses the same pieces:

- On startup it loads config, restores the last working folder
  (`appState.lastCwd`), initializes the voice backend, starts MCP servers and
  the scheduler, then creates the window.
- `buildAgent()` wires the same `Agent`, `Permissions`, and events — but the
  permission prompt function sends a structured `perm:ask` IPC message to the
  renderer and resolves when the user clicks **Once / Always / Deny**.
- All interaction is IPC:
  - `chat:*` — send/stop/compact/undo.
  - `session:*` — new/load/delete/changes.
  - `settings:*` — save settings, set model.
  - `models:list` / `model:list`, `model:set`, `agent:structure` — live model
    catalog and agent→model structure.
  - `voice:*` — transcribe + synthesize.
  - `schedule:*` — list/add/update/toggle/remove/status.
  - `focus:*` — list/answer/cancel.
  - `cost:*` — summary/rebuild.
- `snapshot()` returns the whole UI state (provider, session, cost, sessions
  list, messages, settings, MCP status) to the renderer.
- Electron's user-data and cache dirs are redirected into
  `~/.voidcode/electron-data/` (with GPU caches disabled) to avoid Chromium
  cache lock errors on Windows.

---

## 3. Configuration

### Precedence

```
defaults (src/config.js DEFAULTS)
  ← ~/.voidcode/config.json          (global, user-wide)
    ← <project>/.voidcode.json       (per-project overrides)
```

Merging is deep: nested objects like `permissions` or `voice` merge key by key.

### Key settings

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `openrouter` | Active provider name. |
| `model` | `anthropic/claude-sonnet-4.5` | Model for the main agent. |
| `smallModel` | `''` | Cheaper model used for compaction summaries (falls back to `model`). |
| `providers` | openrouter, ollama, llamacpp, openai | `{ baseUrl, apiKey, apiKeyEnv }` per provider. Any OpenAI-compatible endpoint can be added. |
| `permissions` | bash `ask`, write/edit `allow`, webfetch `allow` | Per-category gate mode (see §5). |
| `bashAllow` | `git status*`, `git diff*`, `ls*`, etc. | Patterns that skip the bash prompt. |
| `contextTokens` | `200000` | Context estimate used for compaction decisions. |
| `compactAt` | `0.75` | Auto-compact when estimated usage crosses this fraction of `contextTokens`. |
| `maxToolRounds` | `100` | Tool rounds per user turn. |
| `interactionStyle` | `collaborative` | `collaborative` or `direct` personality mode. |
| `autonomyLevel` | `off` | `off` / `research` / `safe` / `full` (see §5). |
| `protectedPaths` | `['src/**','app/**','bin/**','test/**']` | Globs that require approval for write/edit at `safe` autonomy. |
| `mcpServers` | `{}` | MCP server definitions (`{ command, args, env }`). |
| `persona` / `memory` | `''` | Custom system-prompt persona and persistent facts. |
| `voice` | see below | Voice settings for the desktop app. |
| `appState` | `{ lastCwd: '' }` | Desktop app UI state (last opened folder). |

The desktop settings modal edits the same keys; everything is saved to the
global config via `config.saveGlobal()`.

### Voice config

```jsonc
"voice": {
  "autoSpeak": true,          // speak replies aloud (desktop)
  "handsFree": false,         // open-mic conversation mode
  "stt": {                    // any OpenAI-compatible /audio/transcriptions endpoint
    "baseUrl": "https://api.groq.com/openai/v1",
    "apiKey": "",
    "model": "whisper-large-v3-turbo"
  },
  "tts": {
    "backend": "edge",        // fish | edge | sapi — falls back down the chain
    "fish": { "apiKey": "", "voiceId": "", "model": "s1" },
    "edge": { "voice": "en-US-AndrewMultilingualNeural" },
    "sapi": { "voice": "" }
  }
}
```

### Project instructions

`AGENTS.md`, then `CLAUDE.md`, then `.voidcode.md` in the project root are all
injected into the system prompt (most specific first, each capped at 20k chars).
`/init` asks the model to analyze the project and write/improve an `AGENTS.md`.

### Model registry

`models.json` (project, any ancestor, the app root, or `~/.voidcode/`) stores
user-authored model entries with `id`, `provider`, `modelName`, `baseUrl`,
`costCategory`, and `capabilities`. This is just one input to the *live*
catalog (§9). The included `models.json` at the repo root ships curated entries
(e.g. `ollama-qwen`, `openrouter-deepseek`) plus a `defaultModel` pointer.

---

## 4. Tools

Tools are defined as OpenAI function schemas plus executor functions, assembled
by `src/tools/index.js`. All core tools are always present; `task`, `focus*`,
and the model tools are added contextually.

| Tool | Source | Notes |
| --- | --- | --- |
| `bash` | `src/tools/bashTool.js` | Runs PowerShell on Windows / `bash` elsewhere. Working directory persists across calls via a sentinel line (`::VOIDCODE_CWD::`). Output capped at 30k chars, timeout 120s default / 600s max. `PAGER`/`GIT_PAGER` neutralized. |
| `read` / `write` / `edit` / `ls` | `src/tools/fsTools.js` | Read is line-numbered with offset/limit; refuses >10 MB. Write/edit snapshot before-content into the session for `/undo`. `edit` enforces uniqueness unless `replaceAll`. Relative paths resolve against the project folder (`ctx.cwd`), not `process.cwd()`. |
| `glob` / `grep` | `src/tools/searchTools.js` | Pure-JS glob (supports `**`, `*`, `?`, `{a,b}`) and regex grep; skip `node_modules`/`.git`/build dirs, skip binaries, cap results. |
| `webfetch` | `src/tools/webTools.js` | GET with HTML→text conversion, retry+backoff (30s timeout), 40k char cap. In focus sessions, every visit is appended to `research_audit_log.md`. |
| `websearch` | `src/tools/webTools.js` | Multi-engine fallback chain (DuckDuckGo → Bing → Mojeek) with 1s retries and a 1h disk cache under `~/.voidcode/cache/`. Returns titles/URLs/snippets; reports per-engine failures and suggests structured searches. |
| `search_repos` / `search_packages` / `search_news` / `rss_fetch` | `src/tools/webTools.js` | Structured JSON searches far more reliable than HTML scraping: GitHub repos (what tools exist), npm registry (installable modules), Hacker News Algolia (fresh ideas), and any RSS/Atom feed. All cached 1h; GitHub returns a rate-limit hint instead of failing. |
| `todowrite` | `src/tools/todoTool.js` | Session-scoped plan; rendered live in the terminal and desktop Plan pane. |
| `project_memory` | `src/tools/memoryTool.js` | Reads/appends/overwrites `.voidcode-memory.md` in the project root; also auto-injected into the system prompt at startup. |
| `schedule` | `src/tools/scheduleTool.js` | Agent-side calendar: list/add/update/remove/show tasks (cron or interval) with per-task autonomy levels. |
| `cost_tracker` | `src/tools/costTool.js` | Project-level USD/token/time summary or per-session breakdown. |
| `task` | `src/tools/index.js` (TASK_DEF) | Inline subagent: runs its own loop with its own context, returns only a final report. Not available inside subagents. |
| `focus`, `focus_status`, `focus_answer`, `focus_board_read`, `focus_board_write` | `src/tools/focusTools.js` | Spawn/manage background autonomous focus agents and the shared board (see §8). Added when `includeFocus` is set (main agent). |
| `list_models`, `model_info`, `current_model`, `set_model`, `assign_model`, `agent_structure` | `src/tools/modelTools.js` | Live model catalog and agent→model management (see §9). Added when `includeModel` is set (main agent). |
| `mcp_<server>_<tool>` | `src/mcp.js` | One def per MCP server tool, namespaced to avoid collisions. |

**Tool-calling fallback.** If native tool calling is unsupported or fails,
`providers.js` scans model text for JSON blocks (`{"name": ..., "arguments": ...}`)
or JSON objects and converts them into tool calls (with a small inference for
`focus`/`write`/`bash`/`webfetch` shapes).

---

## 5. Permissions and autonomy

`src/permissions.js` gates gated actions — `bash`, `write`/`edit`, `webfetch`,
and `mcp_*` tools. Read-only tools (`read`, `ls`, `glob`, `grep`, `todowrite`,
`task`, `project_memory`) are always allowed.

Each category has a mode: `allow` (run silently), `ask` (prompt), `deny`
(refuse).

**Autonomy levels** (config `autonomyLevel`) change how much is auto-allowed:

| Level | Auto-allowed | Still prompts |
| --- | --- | --- |
| `off` | — (everything gated prompts unless `allow`) | all gated actions |
| `research` | `webfetch` | bash, write/edit, mcp |
| `safe` | `bash`, `webfetch`; write/edit **outside** `protectedPaths` | write/edit inside protected paths, mcp |
| `full` | everything | — |

In every mode, `bashAllow` patterns skip prompts for matching bash commands.
Prompt answers are `y` (once), `a` (always for this session), `n` (deny).
Non-interactive (`-p`) and scheduled runs auto-deny anything that would prompt,
so gated actions are simply skipped. Focus subagents run with an
`autonomyLevel: 'full'` override but still resolve permissions against the
normal category modes.

Scheduled tasks can carry their own autonomy level (`research`/`safe`/`full`,
default `safe`) which is applied while the task runs.

---

## 6. Sessions, undo, and cost tracking

### Sessions (`src/sessions.js`)

Every conversation persists to `~/.voidcode/projects/<slug>-<hash>/` as one
JSON file per session containing: id, title, createdAt/updatedAt, usage, full
message history, and up to 50 file-change backups (`fileBackups` —
`{file, before, after, ts}`, `before: null` means the file was created).

- The project dir slug is derived from the folder path
  (`C:\path\to\proj` → `C-path-to-proj-<sha1-8>`), so the same physical project
  always maps to the same directory.
- `/sessions` lists them (newest first), `/resume` / `-c` / `--resume <id>`
  reload one, `/delete` removes one.
- `/undo` pops the most recent backup (restores the previous content, or deletes
  a created file). `/diff` shows all files changed this session with a unified
  diff computed by `ui.diffLines`.

### Cost tracking (`src/costTracker.js`)

`cost.json` in the same project dir holds rolling aggregates: session count,
total cost (USD), active time, input/output tokens, and turns. It is rebuilt
from all session files after every turn (`rebuildFromSessions`) so it always
reflects reality. `/usage` and the `cost_tracker` tool surface it; the desktop
uses it for the cost summary and can rebuild on demand.

---

## 7. Context management

- Estimated context = `JSON.stringify(messages).length / 3.6` tokens.
- Two durable, structured stores live OUTSIDE `session.messages` and are
  therefore never touched by compaction: the **roadmap**
  (`session.todos`, written via `todowrite`, optionally grouped into
  `phase` categories) and the **original task**
  (`session.originalTask`, pinned once from the session-opening message).
  Both are re-injected into every system prompt unconditionally
  (`src/prompt.js`), so the model's plan and its "why am I here" survive
  regardless of how much raw conversation gets retired.
- Auto-compaction triggers when the estimate exceeds `contextTokens *
  compactAt` (default 200k × 0.75) before a turn starts, and again at a 90%
  guard checked every round inside the tool-calling loop (`_loop()` in
  `src/agent.js`) — the latter exists because a single long, tool-heavy turn
  can cross the budget mid-turn, before the next `send()` ever gets a chance
  to check.
- `Agent.compact()` (`src/agent.js` + `src/contextRetirement.js`) retires
  history in bounded chunks, oldest first, instead of flattening the whole
  conversation into one summary:
  - The message list is grouped into atomic **units** first — a
    `tool_calls` message plus all of its matching tool-result messages counts
    as one unit, so a call/response pair is never split across a retirement
    boundary, and the unit boundary is well-defined even when the very last
    message in the list is a tool result (the previous "keep a verbatim
    tail" logic came up empty in exactly that case, which is the normal
    state mid-turn — see the git history for the failure mode this replaced).
  - The most recent `PROTECT_UNITS` units (3) are never retired, whatever
    their shape.
  - Each call retires at most `CHUNK_UNITS` (6) of the oldest remaining
    units. A small-model call extracts, in a fixed labeled format: roadmap
    updates (existing items to mark `in_progress`/`completed`, by index —
    status only ever moves forward, never regresses — plus new items to
    append), durable facts worth persisting project-wide (appended to
    `.voidcode-memory.md` via `project_memory`), and a short pointer
    sentence. The retired chunk is replaced by a single
    `[Older context retired — ...]` pointer message, not a growing
    narrative.
  - `send()` and the mid-turn guard both call `compactUntilUnder()`, which
    retires chunks in a bounded loop until back under budget (or nothing
    more is safely retirable).
- Manual: `/compact` in the terminal, the compact button/IPC in the desktop.
- Compaction failures are non-fatal (best-effort).
- `FocusSession` (`src/focus.js`) has its own, separate, simpler compactor
  (flatten-and-summarize with a verbatim tail) — it is not wired to
  `contextRetirement.js`. Focus sessions are short-lived, time-boxed, and
  discarded on completion, so the durable-roadmap problem this section
  solves does not apply to them the same way.

---

## 8. Subagents, focus agents, and the board

### Inline `task` subagents

`runSubagent()` builds a fresh tool set (no `task`, no focus/model tools), spins
its own `_loop` with a subagent system prompt, and returns only the final report
— keeping the main agent's context small. The user sees a "subagent" line in
the terminal and a card in the desktop.

### Focus agents (`src/focus.js`)

Background autonomous workers with a time budget:

- Spawned via the `focus` tool (description, prompt, `minutes` default 30,
  optional `mode`, `role` and `model`). `mode: "research"` turns the session
  into a timed research sweep (see below).
- Each has its own isolated context window and runs up to `MAX_ROUNDS` (100;
  400 in research mode) rounds until it calls `focus_complete`, its budget
  expires (`timeout`), or it's cancelled.
- They run at full autonomy against the normal permission modes.
- `focus_pause` lets a worker ask the main agent a question — the session goes
  `waiting`, the terminal/desktop shows the question, and `focus_answer` (or
  `/focus answer <id>`) resumes it.
- The shared board (`~/.voidcode/focus/board.json`) supports cross-agent
  messages: `focus_board_write` posts to another agent id or `"main"`;
  `focus_board_read` takes messages addressed to this agent.
- Role/model resolution: an explicit `model` wins; otherwise the role's
  assignment from `AgentRoles` is used; otherwise the main agent's model. The
  word `current`/`main` inherits the main model. Model resolution happens
  against the live catalog, and ambiguous references are rejected with options.

#### Research sweeps (`mode: "research"`)

A timed autonomous research session — the clock, not "feeling done", ends it:

- The system prompt instructs a breadth-first sweep across sources
  (`websearch`, `search_repos`, `search_packages`, `search_news`, `rss_fetch`,
  then `webfetch` on the best hits) with a running findings list and live log
  notes.
- Early `focus_complete` is **rejected** while the budget remains: the executor
  returns a "~N minutes remain — keep researching" message.
- The tool-call cap is raised (`researchMaxToolCalls`, default 250) since a
  sweep is many small searches, and the round cap increases to 400; the
  cap-rounds force-finish is disabled.
- When the deadline hits, the loop forces a final round that compiles the full
  aggregated report, then finishes with status `done`.
- **Live trail**: every `addLog` entry is emitted as a `log` event
  (`onFocusLog` in the terminal, `agent:focusLog` in the desktop Focus panel),
  so search activity streams to the user in real time while `/research` runs.
- `/research <minutes> <topic>` in the terminal starts a research sweep
  directly; the agent can also spawn one via the `focus` tool with `mode`.
- Related `guardrails` knobs: `maxZeroHitStreak`, `maxLearnings`,
  `maxToolCalls` (task mode), `researchMaxToolCalls` (research mode).

### Agent roles (`src/agentRoles.js`)

`~/.voidcode/agent-roles.json` stores, per working directory:

- `roles`: role name → model id (`researcher`, `summarizer`, `analyst`,
  `reviewer`, ...). Used by `focus role=...` and `assign_model`.
- `agents`: explicit agent id → `{ model, role, updatedAt }` for running
  sub-agents.

Resolution priority for a worker: explicit agent assignment → role assignment →
main agent model. `agent_structure` (terminal-style or the `agent_structure`
tool) renders the full map.

---

## 9. Models — the live catalog

There is deliberately no hardcoded model list. `src/modelCatalog.js` merges four
sources into one catalog (stored entries win on duplicate ids):

1. **Stored registry** — `models.json` (project dir, ancestors, app root, or
   `~/.voidcode/`), i.e. explicit user-authored entries.
2. **OpenRouter live catalog** — fetched from
   `https://openrouter.ai/api/v1/models` (works even without a key).
3. **Ollama** — `GET <base>/api/tags` on the local Ollama instance.
4. **llama.cpp / LM Studio** — `GET <base>/models` on the local server (the
   currently loaded GGUF).

The catalog is cached for 30 seconds and keyed by cwd + provider URLs.
`searchModels` provides forgiving slug matching ("deepseek v3" matches
`deepseek/deepseek-chat-v3.1`). `resolveModelRef` maps a human-ish reference to
a `provider/model` string and reports ambiguity.

**Role assignments** live in `AgentRoles` and are independent of the main
agent's model — `set_model` only changes the main agent. The CLI exposes the
catalog via `/models [query]` and `/models set <id>`; the agent itself uses the
model tools (`list_models`, `model_info`, `current_model`, `set_model`,
`assign_model`, `agent_structure`). The desktop has a model picker modal backed
by the same catalog plus a settings field for a raw provider/model string.

---

## 10. Schedules and the scheduler

`src/schedule.js` is the data store: `~/.voidcode/schedule.json` with tasks
that have a title, prompt, schedule (5-field cron **or** interval in minutes),
autonomy level, enabled flag, timestamps, and last result. Cron validation and
next-run computation are implemented from scratch (no dependency): `*`, `*/n`,
`num`, `num,num`, `num-num` per field.

`src/scheduler.js` is the engine: it polls for due tasks every 30 seconds (and
fires immediately on start to catch missed tasks), runs them through a caller-
provided `runTask` callback (the terminal and desktop both route them through
the agent with the task's autonomy level applied), records the result via
`markRan`, and recalculates the next run. Only one task runs at a time.

The agent-side `schedule` tool is the primary management interface ("like a
personal calendar for the agent"); the desktop has a Schedule tab with cards
and a create-modal; the terminal has `/scheduler` for status.

---

## 11. MCP

`src/mcp.js` implements a minimal stdio Model Context Protocol client:

- Config: `mcpServers: { "<name>": { command, args, env } }` in either config
  file; `shell: true` on Windows so `npx ...` style commands work.
- On startup each server is initialized (protocol `2024-11-05`) and its
  `tools/list` is fetched (15s timeout).
- Every tool is exposed to the model as `mcp_<server>_<tool>`, namespaced to
  avoid collisions, with the server's input schema.
- Calls are JSON-RPC over stdio with a 60s per-request timeout; text content is
  returned to the model; errors surface as thrown errors.
- Failures are collected and shown (`/mcp`, startup warnings), never fatal —
  one broken server doesn't stop the app.

---

## 12. The desktop app

### Window & security

`app/main.js` creates a `BrowserWindow` (1500×950, min 980×620, dark bg,
auto-hidden menu bar) with `contextIsolation: true` and `nodeIntegration:
false`. A `preload.js` script exposes the typed `window.vc` API over
`contextBridge`. The renderer's CSP restricts scripts/styles to `self` (inline
styles allowed), media to `self blob:`.

### Renderer (`app/renderer/`)

- `index.html` — layout: top bar (project folder, model, status orb), sidebar
  (new session, session list, settings), chat column (message stream, composer
  with mic / hands-free / TTS / stop / send), right panel with tabs
  **Review · Plan · Schedule · Focus**. Modals: settings, schedule task, model
  picker.
- `app.js` — glue: subscribes to agent events (`onDelta`, `onToolStart/End`,
  `onFileChange`, `onTodos`, `onStatus`, `onSubagent*`, `onFocus*`,
  `onPermAsk`), renders streaming markdown, tool cards, permission prompts
  (Once / Always / Deny), session list/history, schedule cards, focus panel,
  model picker, and agent-structure view.
- `md.js` — dependency-free markdown → HTML renderer (headers, fences, inline
  code, bold/italic, lists, blockquotes, links, hr).
- `diff.js` — LCS line diff rendered as HTML with ±2 context lines.
- `voice.js` — `VoiceIO` class: push-to-talk (Ctrl+Space), hands-free open-mic
  with voice-activity detection (WebAudio RMS + adaptive noise floor), barge-in
  (talking cuts off TTS and stops generation), and a sequential TTS playback
  queue fed sentence-by-sentence while the reply streams.
- `styles.css` — dark, quiet theme with CSS variables; tool cards, schedule
  cards, modals, model list, diffs, focus panel.

### Voice backend (`app/voice.js`)

- **STT**: POSTs audio to any OpenAI-compatible `/audio/transcriptions`
  endpoint (Groq's free whisper tier is the documented default).
- **TTS**: a fallback chain `fish → edge → sapi` (config order decides the
  start): Fish Audio API, Microsoft Edge neural voices via `msedge-tts`, then
  Windows built-in SAPI via PowerShell. Markdown is stripped before speaking.
- The scheduler also speaks task completions/failures when `voice.autoSpeak`.

### Web Portal (`app/portal.js` + `app/portalWeb/`)

A zero-dependency mobile remote: the same engine served over HTTP from the
desktop app, deliberately locked down.

- **Listen**: an `http.Server` bound to `127.0.0.1` only (never to a LAN
  interface). Config `webPortal.{enabled,tunnel,port,cloudflaredPath}`; UI in
  Settings → Web Portal.
- **Auth**: each start generates a random 32-byte token. `POST /api/login`
  exchanges it for an `HttpOnly SameSite=Lax` cookie (`vc`); every JSON API and
  the SSE stream require that cookie (`timingSafeEqual`). Stopping the portal
  rotates/kills the token and closes the server. `/healthz` is the single
  unauthenticated probe.
- **Tunnel**: with `tunnel: "cloudflared"`, the app spawns
  `cloudflared tunnel --url http://127.0.0.1:<port>`; the `*.trycloudflare.com`
  URL is captured from its logs by regex. The tunnel is the *only* public path
  and connects to the loopback listener. `findCloudflared()` probes the PATH,
  `%LOCALAPPDATA%\cloudflared`, `~/.cloudflared`, and `Program Files`. On a
  missing binary, start returns a "install with `winget install cloudflared`"
  warning but still serves localhost.
- **Events**: every `send()` in `app/main.js` is also forwarded to
  `portal.emit()` → a `/api/events` SSE stream (`agent:delta`,
  `agent:toolStart/End`, `agent:todos`, `agent:focusLog`, `perm:ask` …).
- **Adapter**: `app/main.js` builds a `portalAdapter()` that maps the portal's
  JSON routes to the running engine: a shared `runChat()` (one
  `generating` guard for desktop + portal), `focusList`/`focusAnswer`,
  `permAnswer` (resolves `pendingPerms`), `stopAgent`, `compact`, `undo`.
- **UI**: `app/portalWeb/{index.html,app.js,styles.css}` — mobile-first chat
  with token login, streaming markdown bubbles, tool/focus notes, permission
  cards (Allow once / Always / Deny), stop button, and a focus-session drawer
  with inline answer boxes. All local, no CDNs, matching the renderer's CSP
  constraints.

---

## 13. Packaging and installation

- `npm start` → terminal (`node bin/voidcode.js`).
- `npm run app` → desktop (`electron app/main.js`); `launch.bat` is a shortcut.
- `installer.ps1` — a PowerShell + WPF installer with a GUI (and a `-Silent`
  mode): checks for Node ≥ 20 (downloads and installs the MSI if missing),
  checks npm, runs `npm install`, checks git (informational), and offers to
  launch. `-Silent -LaunchAfter` does the whole flow headless.
- Dependencies: `electron` (dev, desktop only) and `msedge-tts` (voice TTS).
  The core has none.

---

## 14. Testing

`npm test` runs `test/harness.test.js` with **no API keys**:

- **Unit tests**: glob→regex translation, `resolveProvider` prefix behavior,
  diff detection, relative-path resolution against `ctx.cwd` (regression for
  paths escaping the project folder), persona/memory injection into the system
  prompt.
- **End-to-end**: spins up a local HTTP mock that speaks SSE with a scripted
  multi-round tool session (`write → edit → bash → read → final`), runs
  `voidcode -p` against it in a temp project, and asserts: exit code 0, exactly
  5 model rounds, system prompt present, tools advertised, real file effects on
  disk, the model saw both edit-readback and bash output, and the session was
  persisted.
- **Regression**: a stalled stream (provider sends a few bytes then goes
  silent) must abort with a descriptive "stalled" error, not hang and not
  masquerade as a user AbortError.

---

## 15. Extending

### Add a tool

1. Create `src/tools/<name>Tool.js` exporting `defs` (array of OpenAI-format
   tool definitions) and `makeExecutors(ctx)`.
2. Wire it into `src/tools/index.js` (spread `defs` into the base list and
   merge executors). Contextual tools (like focus/model) use the
   `includeFocus` / `includeModel` flags.
3. The tool is immediately available to the model; add a test in
   `test/harness.test.js` if you like.

### Add a slash command

Handle the new command in the `handleSlash` switch in `src/index.js` and add a
line to `HELP`. Desktop-only commands go in `app/main.js` as an IPC handler plus
a `preload.js` method.

### Add an autonomy level or permission category

Extend the table in the `prompt.js` autonomy block, `permissions.js`
(`categoryFor` / `check`), and the settings menus (terminal + desktop).

### Add a provider

Add an entry under `providers` in config (name, `baseUrl`, optional
`apiKey`/`apiKeyEnv`) — everything else (streaming, tool calls, usage) works
automatically because the client speaks the OpenAI wire format.

---

## 16. File layout

```
voidcode/
├── bin/voidcode.js          CLI entry
├── src/                     terminal engine + shared core
│   ├── index.js             REPL, slash commands, render wiring, scheduler hookup
│   ├── agent.js             agent loop, compaction, subagents, usage
│   ├── providers.js         streaming + non-streaming chat client, fallbacks
│   ├── prompt.js            system prompt builder
│   ├── config.js            merged config, provider resolution, registry
│   ├── permissions.js       gates + autonomy levels
│   ├── sessions.js          session persistence + undo snapshots
│   ├── costTracker.js       project cost/time aggregates
│   ├── schedule.js          task store, cron validation/next-run
│   ├── scheduler.js         30s background task runner
│   ├── focus.js             background focus agents + board
│   ├── agentRoles.js        role/agent → model assignments
│   ├── modelCatalog.js      live model discovery + resolution
│   ├── mcp.js               stdio MCP client
│   ├── ui.js                ANSI/colors, markdown, diffs, spinner
│   └── tools/               tool definitions + executors
│       ├── index.js         registry/assembler
│       ├── bashTool.js  fsTools.js  searchTools.js  webTools.js
│       ├── todoTool.js  memoryTool.js  scheduleTool.js  costTool.js
│       ├── focusTools.js  modelTools.js
├── app/                     Electron desktop app
│   ├── main.js              window, IPC, agent wiring, scheduler, voice
│   ├── preload.js           contextBridge API (window.vc)
│   ├── portal.js            web portal + cloudflared quick-tunnel manager
│   ├── portalWeb/           mobile portal UI: index.html, app.js, styles.css
│   ├── voice.js             STT + TTS backend
│   └── renderer/            UI: index.html, app.js, styles.css,
│                            md.js, diff.js, voice.js
├── test/harness.test.js     unit + e2e tests (no API keys)
├── models.json              stored model registry (curated defaults)
├── installer.ps1            PowerShell/WPF installer
├── launch.bat               desktop launcher
└── package.json
```

## 17. Data locations

| Data | Where |
| --- | --- |
| Global config | `~/.voidcode/config.json` |
| Per-project config | `<project>/.voidcode.json` |
| Sessions + cost | `~/.voidcode/projects/<slug>-<hash>/` |
| Model registry | `models.json` (project → ancestors → app root → global) |
| Scheduled tasks | `~/.voidcode/schedule.json` |
| Agent role assignments | `~/.voidcode/agent-roles.json` |
| Focus message board | `~/.voidcode/focus/board.json` |
| Electron user data/cache | `~/.voidcode/electron-data/` |
| Project memory | `<project>/.voidcode-memory.md` |
| Project instructions | `<project>/AGENTS.md`, `CLAUDE.md`, `.voidcode.md` |