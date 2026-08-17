// Focus system: background sub-agents with autonomous loops, time budgets,
// and a shared message board for cross-agent communication.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { streamChat, complete } = require('./providers');
const { buildSystemPrompt } = require('./prompt');
const { Permissions } = require('./permissions');
const { projectDir } = require('./sessions');
const guardrails = require('./guardrails');
const { buildContinuationPacket, clip } = require('./continuationPacket');

const BOARD_DIR = path.join(os.homedir(), '.voidcode', 'focus');
const BOARD_FILE = path.join(BOARD_DIR, 'board.json');

const estTokens = (messages) => Math.ceil(JSON.stringify(messages).length / 3.6);

function ensureBoardDir() {
  try { fs.mkdirSync(BOARD_DIR, { recursive: true }); } catch {}
}

function loadBoard() {
  ensureBoardDir();
  try { return JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8')) || {}; } catch { return {}; }
}

function saveBoard(data) {
  ensureBoardDir();
  try { fs.writeFileSync(BOARD_FILE, JSON.stringify(data, null, 2), 'utf8'); } catch {}
}

class FocusBoard {
  constructor() {
    this.data = loadBoard(); // { toId: [{ from, to, kind, content, ts }] }
  }

  post({ to, from, kind = 'note', content }) {
    const arr = this.data[to] || [];
    arr.push({ from, to, kind, content, ts: Date.now() });
    this.data[to] = arr;
    saveBoard(this.data);
  }

  read({ to, from, since = 0 }) {
    const arr = this.data[to] || [];
    return arr.filter(m => m.ts > since && (!from || m.from === from));
  }

  take({ to, since = 0 }) {
    const arr = this.data[to] || [];
    const fresh = arr.filter(m => m.ts > since);
    const old = arr.filter(m => m.ts <= since);
    this.data[to] = old;
    saveBoard(this.data);
    return fresh;
  }
}

const board = new FocusBoard();

const MAX_ROUNDS = 100;
const RESEARCH_MAX_ROUNDS = 400;

function genId() {
  return 'f-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

class FocusSession {
  constructor({ id, manager, description, prompt, deadlineMs, agentRefs, modelOverride, role, mode }) {
    this.id = id;
    this.manager = manager;
    this.description = description || 'focus task';
    this.prompt = prompt;
    this.deadline = Date.now() + deadlineMs;
    this.createdAt = Date.now();
    this.status = 'working'; // working | waiting | done | error | timeout
    this.messages = [{ role: 'user', content: prompt }];
    this.finalReport = '';
    this.scratchpad = '';
    this.abort = new AbortController();
    this._pauseResolve = null;
    this._pauseReject = null;
    this.question = null;
    this.log = [];
    this.agentRefs = agentRefs; // { provider, cfg, cwd, mcpServers, toolCtx }
    this.modelOverride = modelOverride;
    this.role = role || null;
    this.mode = mode || 'task';
    this.untilDeadline = this.mode === 'research';
    this._toolCalls = 0;
    this._capRounds = 0;
    this._streakLessonLogged = false;
    // Continuation-packet state for the "model returned no tool call" branch
    // in run() — see buildContinuationPacket usage below. Never persisted
    // into this.messages; consumed once per retry, ephemeral only.
    this._pendingContinuation = null;
    this._emptyRounds = 0;
  }

  // Accepts a plain string (legacy narrative note — "compacting context…",
  // "asked: ...") or a structured record ({ kind: 'tool'|'thought'|'note',
  // ... }). Every stored record carries `kind` and a renderable summary so
  // the desktop UI can show a real activity timeline (tool calls, model
  // "thinking" prose, and milestone notes) when a user drills into a
  // session — not just the sparse error/milestone narration this used to be
  // limited to.
  addLog(entryOrRecord) {
    const record = typeof entryOrRecord === 'string'
      ? { kind: 'note', text: entryOrRecord }
      : { kind: 'note', ...entryOrRecord };
    const full = { ts: Date.now(), ...record };
    this.log.push(full);
    if (this.log.length > 300) this.log.shift();
    try { this.manager.emit('log', this, full); } catch {}
    return full;
  }

  async generateScratchpad(turnProvider) {
    const transcript = this.messages
      .slice(-15)
      .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 500) : ''}`)
      .join('\n');

    const prompt = [
      { role: 'system', content: 'You are a cognitive processor. Read the chat history and update the scratchpad. Keep it to exactly 2-3 bullet points representing: 1) Active Goal, 2) Current Status/Findings, 3) Immediate Next Step. Be extremely concise. Respond in English only. Under 80 words.' },
      { role: 'user', content: `Current Scratchpad:\n${this.scratchpad || 'None'}\n\nRecent History:\n${transcript}` }
    ];
    
    const summary = await complete(turnProvider || this.agentRefs.provider, prompt, { maxTokens: 150 });
    return summary.trim();
  }

  get remainingMs() {
    return Math.max(0, this.deadline - Date.now());
  }

  get remainingMin() {
    return Math.ceil(this.remainingMs / 60000);
  }

  pauseForAnswer(question) {
    this.status = 'waiting';
    this.question = question;
    this.addLog(`asked: ${question}`);
    this.manager.emit('question', this, question);
    return new Promise((resolve, reject) => {
      this._pauseResolve = resolve;
      this._pauseReject = reject;
    });
  }

  resume(answer) {
    if (this._pauseResolve) {
      this._pauseResolve(answer || '(no response)');
      this._pauseResolve = null;
      this._pauseReject = null;
    }
    this.status = 'working';
    this.question = null;
    this.manager.emit('resume', this);
  }

  finish(report, status = 'done') {
    this.status = status;
    this.finalReport = report;
    this.addLog(`finished (${status}): ${report?.slice(0, 200) || ''}`);
    this.manager.emit('done', this, status, report);
  }

  needsCompaction(turnProvider, systemPromptTokens = 0) {
    const limit = turnProvider.contextTokens || this.agentRefs.cfg.contextTokens || 200000;
    return estTokens(this.messages) + systemPromptTokens > limit * (this.agentRefs.cfg.compactAt || 0.75);
  }

  async compact(turnProvider) {
    const msgs = this.messages;
    if (msgs.length < 6) return false;
    const keepTail = 4;
    const toSummarize = msgs.slice(0, msgs.length - keepTail);
    const tail = msgs.slice(-keepTail);
    this.addLog('compacting context…');
    const transcript = toSummarize.map((m) => {
      const role = m.role;
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const tools = m.tool_calls ? ` [called: ${m.tool_calls.map((t) => t.function.name).join(', ')}]` : '';
      return `${role}${tools}: ${String(content).slice(0, 2000)}`;
    }).join('\n');

    const limit = turnProvider.contextTokens || this.agentRefs.cfg.contextTokens || 200000;
    const isSmallCtx = limit <= 8192;
    const maxSummaryWords = isSmallCtx ? 250 : 1500;
    const maxSummaryTokens = isSmallCtx ? 400 : 3000;

    let smallProv = turnProvider;
    try {
      const { resolveProvider } = require('./config');
      if (this.agentRefs.cfg.smallModel) {
        smallProv = resolveProvider(this.agentRefs.cfg, this.agentRefs.cfg.smallModel);
      }
    } catch {}

    const { complete } = require('./providers');
    const summary = await complete(smallProv, [
      { role: 'system', content: `Summarize this background coding research session for context continuation. Preserve: the task and details, files searched/read, key findings, and current state. Be dense and factual. Under ${maxSummaryWords} words.` },
      { role: 'user', content: transcript.slice(0, 300000) },
    ], { maxTokens: maxSummaryTokens });

    this.messages = [
      { role: 'user', content: `[Research session compacted. Summary of findings and progress so far:]\n\n${summary}` },
      { role: 'assistant', content: 'Understood — continuing research.' },
      ...tail.filter((m) => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls && typeof m.content === 'string')),
    ];
    return true;
  }

  async run() {
    const { provider, cfg, cwd, mcpServers, toolCtx, suggestFailoverModelFn } = this.agentRefs;

    // Digital-organism mode: focus sessions draw from the shared treasury and
    // are bounded by the same per-task budget rules as the main agent. When
    // enabled and no explicit model was requested, route the session to the
    // cheapest adequate model for its workload.
    const organism = this.agentRefs.organism || null;
    if (!this.modelOverride && organism && (cfg.organism?.autoSelectModels !== false)) {
      try {
        const choice = await organism.selectModel({ task: this.prompt, difficulty: 2 });
        if (choice.model) this.modelOverride = choice.model;
      } catch { /* inherit the main provider */ }
    }
    let orgGuard = null;
    if (organism) {
      try {
        const budget = organism.budgetFor({ difficulty: 3, capability: null });
        orgGuard = organism.makeLoopGuard(budget);
        this.addLog(`organism: focus budget capped at ${budget.cap.toFixed(4)}`);
      } catch { orgGuard = null; }
    }

    // Resolve provider with model override if specified
    let sessionProvider = provider;
    if (this.modelOverride) {
      const { resolveProvider } = require('./config');
      try {
        sessionProvider = resolveProvider(cfg, this.modelOverride);
      } catch (err) {
        this.addLog(`model override failed: ${err.message}, using default provider`);
      }
    }

    const permCfg = { ...cfg, autonomyLevel: 'full' };
    const perms = new Permissions(permCfg, () => 'a');

    const { build } = require('./tools');
    const subTools = build({
      cwd,
      shellCwd: cwd,
      cfg,
      provider: sessionProvider,
      focusSession: this,
      onFileChange: (file, before, after) => toolCtx.onFileChange?.(file, before, after),
      onTodos: () => {},
      contextResolver: this.agentRefs.contextResolver,
      onContextTrace: (trace) => toolCtx.onContextTrace?.(trace),
      agentKind: 'focus',
    }, { mcpServers, includeTask: false });

    let completedReport = null;
    let databaseContext = null;
    if (this.agentRefs.contextResolver) {
      try {
        databaseContext = await this.agentRefs.contextResolver.resolve({ task: this.prompt, agentKind: 'focus' });
        toolCtx.onContextTrace?.(databaseContext.trace);
      } catch (err) {
        this.addLog(`context lookup failed: ${err.message}`);
      }
    }

    subTools.apiDefs.push(
      { type: 'function', function: { name: 'focus_pause', description: 'Pause and ask the main agent a question. Provide a concise question. The loop waits for the answer then continues.', parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } } },
      { type: 'function', function: { name: 'focus_board_read', description: 'Read messages on the shared board addressed to this subagent.', parameters: { type: 'object', properties: { since: { type: 'number', description: 'Timestamp to read messages after' } }, required: [] } } },
      { type: 'function', function: { name: 'focus_board_write', description: 'Post a message to the shared board for another subagent (or "main").', parameters: { type: 'object', properties: { to: { type: 'string' }, kind: { type: 'string', enum: ['note', 'result', 'request'] }, content: { type: 'string' } }, required: ['to', 'content'] } } },
      { type: 'function', function: { name: 'focus_complete', description: 'Submit your final report and complete the focus session. Call this only when the entire task is finished (in research mode, calling it while time remains is rejected by the loop).', parameters: { type: 'object', properties: { report: { type: 'string', description: 'Thorough, detailed final report summarizing all findings and work done.' } }, required: ['report'] } } }
    );

    subTools.executors.focus_pause = async ({ question }) => {
      return '__FOCUS_PAUSE__:' + JSON.stringify({ question });
    };
    subTools.executors.focus_board_read = async ({ since = 0 }) => {
      const msgs = board.take({ to: this.id, since });
      if (!msgs.length) return '(no new messages)';
      return msgs.map(m => `[${m.from}] ${m.kind}: ${m.content}`).join('\n---\n');
    };
    subTools.executors.focus_board_write = async ({ to, kind = 'note', content }) => {
      board.post({ to, from: this.id, kind, content });
      return `Posted to ${to}`;
    };
    subTools.executors.focus_complete = async ({ report }) => {
      if (this.untilDeadline && Date.now() < this.deadline) {
        const min = Math.max(1, Math.ceil((this.deadline - Date.now()) / 60000));
        this.addLog(`focus_complete rejected — ~${min}min of research budget remain`);
        return `[Research mode] ~${min} minutes of budget remain. Do NOT finish yet. Keep researching: run NEW searches on adjacent topics, follow the most promising links with webfetch, and rotate sources (websearch, search_repos, search_packages, search_news, rss_fetch). You will be prompted to submit your full compiled report when the clock expires.`;
      }
      completedReport = report;
      return 'Report submitted successfully. Session will close.';
    };

    let useTools = subTools;
    // Reassignable — a detected model collapse (see below) swaps it mid-loop
    // without touching this.agentRefs.provider (the shared main-agent
    // provider), so a background session's collapse can't silently change
    // the user's own main model.
    let activeProvider = sessionProvider;
    const collapsedModelIds = new Set();
    let collapseRetries = 0;
    const MAX_COLLAPSE_RETRIES = 2;
    const roundLimit = this.untilDeadline ? RESEARCH_MAX_ROUNDS : MAX_ROUNDS;
    for (let round = 0; round < roundLimit; round++) {
      if (this.abort.signal.aborted) {
        this.finish('Interrupted by user', 'error');
        break;
      }
      if (Date.now() >= this.deadline) {
        this.messages.push({ role: 'system', content: '[System: Time budget exhausted. Provide your final report now.]' });
        // one more round to allow final answer
      }

      const turnProvider = activeProvider;

      // Update scratchpad every 3 rounds (or if empty and we have history)
      if (this.messages.length >= 2 && (round % 3 === 0 || !this.scratchpad)) {
        try {
          this.scratchpad = await this.generateScratchpad(turnProvider);
        } catch (err) {
          // best-effort
        }
      }

      const systemPrompt = buildSystemPrompt({
        cwd,
        subagent: true,
        focus: { id: this.id, description: this.description, minutes: this.remainingMin || 30, mode: this.mode },
        scratchpad: this.scratchpad,
        contextTokens: turnProvider.contextTokens || cfg.contextTokens,
        databaseContext
      });

      const sysPromptTokens = estTokens([{ role: 'system', content: systemPrompt }]);
      const toolTokens = estTokens(useTools ? useTools.apiDefs : []);

      if (this.needsCompaction(turnProvider, sysPromptTokens + toolTokens)) {
        try {
          await this.compact(turnProvider);
        } catch (err) {
          this.addLog(`compaction failed: ${err.message}`);
        }
      }

      let result;
      try {
        const messagesToSend = [...this.messages];
        const cfgG = (this.agentRefs.cfg || {}).guardrails || {};

        if (messagesToSend.length > 0) {
          const additions = guardrails.intercept({
            messages: this.messages,
            kind: 'focus',
            context: { cfg: this.agentRefs.cfg, cwd, session: this },
          });
          for (const addition of additions) {
            messagesToSend.push({ role: 'system', content: addition });
          }

          // Mechanical loop-breaker: record a reusable lesson the first time the
          // model hits a repeated empty/error-search wall.
          const maxStreak = cfgG.maxZeroHitStreak || 3;
          if (!this._streakLessonLogged && guardrails.zeroHitStreak(this.messages) >= maxStreak) {
            this._streakLessonLogged = true;
            guardrails.recordLesson({
              title: 'repeated empty/error search results',
              trigger: 'No search results found.',
              behavior: 'Stop re-searching the same topic after two empty results; move on to other task areas, note the gap, and finish with an honest report or pause for clarification.',
              category: 'focus',
              maxLearnings: cfgG.maxLearnings || 30,
            });
          }
        }

        // One-shot structured continuation packet (see the no-tool-calls
        // branch below): consumed here so it never pollutes this.messages.
        if (this._pendingContinuation) {
          messagesToSend.push({ role: 'system', content: this._pendingContinuation });
          this._pendingContinuation = null;
        }

        const repeated = guardrails.repeatedToolCallStreak(this.messages);
        const repeatedStopAt = cfgG.repeatedToolCallStopAt || 4;
        if (repeated.count >= repeatedStopAt) {
          const reason = `repeated tool-call loop stopped safely: ${repeated.name || 'the same tool'} was called ${repeated.count} consecutive times with identical arguments; the tool may not have fired or its response may be missing/unchanged.`;
          this.addLog(reason);
          this.finish(`[${reason}]`, 'error');
          break;
        }

        // Mechanical loop-breaker: hard tool-call cap. Research sweeps are
        // timed (deadline-gated), so they get a much higher cap.
        const defaultCap = cfgG.maxToolCalls || 25;
        const toolCap = this.untilDeadline ? Math.max(defaultCap, cfgG.researchMaxToolCalls || 250) : defaultCap;
        if (this._toolCalls >= toolCap) {
          this._capRounds++;
          messagesToSend.push({
            role: 'system',
            content: `[System Rule - Tool Cap] You have made ${this._toolCalls} tool calls (session allows ${toolCap}). Make NO further tool calls. Call focus_complete now with your final report.`
          });
        }

        result = await streamChat(turnProvider,
          [{ role: 'system', content: systemPrompt }, ...messagesToSend],
          useTools ? useTools.apiDefs : null,
          { quiet: true, signal: this.abort.signal });
      } catch (err) {
        if (this.abort.signal.aborted) break;
        this.addLog(`stream error: ${err.message}`);
        
        const isContextError = /exceed.*context|context.*exceed|available context size|n_ctx/i.test(err.message);
        if (isContextError) {
          const match = err.message.match(/(?:context size|n_ctx)[^\d]*(\d+)/i);
          const detectedLimit = match ? parseInt(match[1], 10) : 4096;
          turnProvider.contextTokens = detectedLimit;
          this.addLog(`detected actual context limit of ${detectedLimit} tokens; compacting and retrying…`);
          let compacted = false;
          try {
            compacted = await this.compact(turnProvider);
          } catch (compErr) {
            this.addLog(`compaction failed: ${compErr.message}`);
          }
          if (compacted) {
            round--; // retry this round
            continue;
          }
          throw new Error(`Context limit of ${detectedLimit} tokens exceeded (unable to compact further).`);
        }
        
        const isJinjaError = (turnProvider.name === 'ollama' || turnProvider.name === 'llamacpp') &&
          /template|parser|Jinja|tool/i.test(err.message);
        if (isJinjaError && useTools) {
          this.addLog('local model tool-template error; retrying without native tool calling…');
          useTools = null;
          round--; // don't count this as a round
          continue;
        }

        // Digital-organism mode: a budget breach (spending cap crossed or too
        // many unproductive rounds) ends the session cleanly with an audit
        // trail rather than crashing the background runner.
        if (organism && (err.organismBudgetStop || /Insufficient treasury balance/.test(err.message))) {
          this.addLog(`organism budget stop: ${err.message}`);
          this.finish(`[organism budget stop] ${err.message}`, 'error');
          break;
        }

        if (!this._isTransient(err)) throw err;
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // Defense in depth: strip any internal harness tag echoed back
      // verbatim before it is persisted, streamed, or acted on.
      if (typeof result.content === 'string' && result.content) {
        result.content = guardrails.stripLeakedSystemTags(result.content);
      }

      // Digital-organism mode: debit the shared treasury for this focus round.
      if (organism && orgGuard && result?.usage) {
        try {
          const costUSD = typeof result.usage.total_cost === 'number'
            ? result.usage.total_cost
            : await organism._computeCallCost(turnProvider, result.usage);
          const progress = result.toolCalls.length > 0 || (result.content && result.content.trim());
          orgGuard.chargeRound(costUSD, { progress });
          await organism.charge({
            costUSD,
            model: turnProvider ? `${turnProvider.name}/${turnProvider.model}` : null,
            input: result.usage.prompt_tokens || 0,
            output: result.usage.completion_tokens || 0,
            kind: 'focus',
            actor: this.id,
            task: `focus: ${this.description || this.prompt}`,
          });
        } catch (orgErr) {
          if (orgErr.organismBudgetStop || /Insufficient treasury balance/.test(orgErr.message)) {
            this.addLog(`organism budget stop: ${orgErr.message}`);
            this.finish(`[organism budget stop] ${orgErr.message}`, 'error');
            break;
          }
          // Transient failures (catalog fetch, etc.) should not kill the loop.
        }
      }

      // Model collapse detection: some models occasionally degenerate into a
      // tight loop over a handful of words/phrases instead of a real answer
      // — a sampling/provider fault, not real progress. Switch to a
      // similarly-priced sibling model on the same provider and retry this
      // round rather than burning the rest of the session's time/credit
      // budget on a model that just proved broken — this matters even more
      // here than for an interactive turn, since a background session runs
      // unattended for its full deadline with nobody watching it loop.
      if (typeof result.content === 'string' && result.content) {
        const collapse = guardrails.detectRepetitionCollapse(result.content);
        if (collapse) {
          const failedId = `${turnProvider.name}/${turnProvider.model}`;
          collapsedModelIds.add(failedId);
          const detail = collapse.kind === 'vocabulary'
            ? `only ${collapse.uniqueWords} unique words across ${collapse.totalWords}`
            : `"${collapse.gram}" repeated ${collapse.count}x`;
          this.addLog({ kind: 'note', text: `model collapse on ${failedId} (${detail}) — looking for a similarly-priced alternative…` });
          try {
            guardrails.recordLesson({
              title: `${failedId} output collapse`,
              trigger: failedId,
              behavior: 'This model has degenerated into repetitive garbage output before under this harness. Prefer switching to an alternate model of similar cost if it happens again.',
              category: 'all',
              maxLearnings: (cfg.guardrails && cfg.guardrails.maxLearnings) || 30,
            });
          } catch { /* best-effort */ }

          let switched = false;
          if (collapseRetries < MAX_COLLAPSE_RETRIES) {
            collapseRetries++;
            try {
              const failoverFn = suggestFailoverModelFn || require('./modelCatalog').suggestFailoverModel;
              const alt = await failoverFn(cfg, cwd, failedId, { excludeIds: [...collapsedModelIds] });
              if (alt) {
                const altId = `${alt.provider}/${alt.modelName}`;
                const { resolveProvider } = require('./config');
                activeProvider = resolveProvider(cfg, altId);
                this.modelOverride = altId;
                switched = true;
                this.addLog({ kind: 'note', text: `switched to ${altId} after model collapse — retrying…` });
              } else {
                this.addLog({ kind: 'note', text: `no alternate model available in ${failedId}'s price range; continuing on the same model.` });
              }
            } catch (err) {
              this.addLog({ kind: 'note', text: `could not switch models after collapse: ${err.message}` });
            }
          }
          if (switched) { round--; continue; }
          // Retries exhausted or no alternate found: fall through and treat
          // the collapsed text as this round's answer/report rather than
          // looping forever chasing a replacement that isn't there.
        }
      }

      if (completedReport !== null) {
        this.finish(completedReport, 'done');
        break;
      }

      if (!result.toolCalls.length) {
        const content = result.content || '';
        if (Date.now() >= this.deadline) {
          this.finish(content || '(no output)', this.untilDeadline ? 'done' : 'timeout');
          break;
        }
        if (content.trim()) {
          this.messages.push({ role: 'assistant', content });
          this.addLog({ kind: 'thought', text: clip(content, 500) });
          // Real prose this round (just no tool call / focus_complete yet) —
          // a legitimate, if incomplete, turn. Only genuinely BLANK
          // completions (no text AND no tool call) count toward the
          // stuck-loop stop condition below.
          this._emptyRounds = 0;
        } else {
          this._emptyRounds++;
        }

        // Structured continuation packet instead of a blank/fake user
        // message — anchored to the real last tool call and result (if any)
        // so the model is told exactly what happened, not left to guess.
        const lastToolMsg = [...this.messages].reverse().find((m) => m.role === 'tool');
        const toolName = guardrails.lastToolName(this.messages);
        const MAX_EMPTY_ROUNDS = 5;
        if (!content.trim() && this._emptyRounds > MAX_EMPTY_ROUNDS) {
          this.finish(`[continuation state exhausted] ${this._emptyRounds} consecutive round(s) produced no text and no tool call${toolName ? ` after "${toolName}" ran` : ''}. Stopping rather than letting the model guess further.`, 'error');
          break;
        }
        this._pendingContinuation = buildContinuationPacket({
          activeTask: this.description || this.prompt,
          planStep: this.scratchpad ? `scratchpad: ${this.scratchpad}` : null,
          remainingSteps: this.untilDeadline
            ? `time-boxed until deadline (~${this.remainingMin} minute(s) left)`
            : `${Math.max(0, roundLimit - round - 1)} round(s) remain`,
          previousIntendedAction: toolName ? `${toolName} tool call` : 'no tool call has run yet this session',
          toolCalled: toolName || 'none',
          toolResult: lastToolMsg ? { ok: !/^(ERROR|DENIED|FAILED):/i.test(String(lastToolMsg.content || '')), output: lastToolMsg.content } : null,
          completedWork: this._toolCalls ? [`${this._toolCalls} tool call(s) executed so far this session`] : [],
          expectedNextStep: this.untilDeadline
            ? 'Continue researching new topics/sources with concrete tool calls; do not call focus_complete before the clock expires.'
            : 'Take a concrete next action (a tool call), or call focus_complete if the task is genuinely finished.',
          stopConditions: [
            'If you are stuck with no valid next action, call focus_pause and ask a clarifying question instead of guessing.',
            `${this._emptyRounds} consecutive blank round(s) so far (session stops after ${MAX_EMPTY_ROUNDS}).`,
          ],
        });
        continue;
      }

      if (result.content && result.content.trim()) {
        this.addLog({ kind: 'thought', text: clip(result.content, 500) });
      }
      this.messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });
      this._emptyRounds = 0;

      for (const call of result.toolCalls) {
        if (this.abort.signal.aborted) break;
        const name = call.function.name;
        if (name !== 'focus_complete') this._toolCalls++;
        let args = {};
        let parseError = null;
        try {
          args = parseToolArgs(call.function.arguments || '{}');
        } catch (err) {
          parseError = err;
        }

        if (name === 'focus_pause') {
          const q = args.question;
          const answer = await this.pauseForAnswer(q);
          this.messages.push({ role: 'tool', tool_call_id: call.id, content: `Main agent answered: ${answer}` });
          continue;
        }

        let output, ok = true;
        const executor = subTools.executors[name];
        if (!executor) {
          ok = false;
          output = `ERROR: unknown tool "${name}"`;
        } else if (parseError) {
          ok = false;
          output = `ERROR: ${parseError.message}`;
        } else {
          try {
            const allowed = await perms.check(name, args, { autonomous: true });
            if (!allowed) {
              ok = false;
              output = 'DENIED: permission check failed';
            } else {
              output = await executor(args);
            }
          } catch (err) {
            ok = false;
            output = `ERROR: ${err.message}`;
          }
        }
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: String(output) });
        this.addLog({ kind: 'tool', tool: name, args, ok, output: clip(String(output), 400) });
      }

      if (completedReport !== null) {
        this.finish(completedReport, 'done');
        break;
      }

      if (Date.now() >= this.deadline && this.status === 'working') {
        this.messages.push({ role: 'system', content: '[System: Time budget exhausted. Provide your final report now.]' });
      }

      if (this._capRounds >= 3 && this.status === 'working' && !this.untilDeadline) {
        const lastMsg = this.messages[this.messages.length - 1];
        this.finish((lastMsg && typeof lastMsg.content === 'string' ? lastMsg.content : 'Tool-call limit reached') , 'error');
        break;
      }
    }

    if (this.status === 'working') {
      this.finish('Time limit reached', 'timeout');
    }
  }

  _isTransient(err) {
    const m = String(err?.message || '');
    return /fetch failed|stalled|terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket|network|HTTP (408|429|5\d\d)/i.test(m);
  }

  getStatus() {
    return {
      id: this.id,
      description: this.description,
      status: this.status,
      question: this.question,
      remainingMs: this.remainingMs,
      remainingMin: this.remainingMin,
      createdAt: this.createdAt,
      model: this.modelOverride || null,
      role: this.role,
      log: this.log.slice(-5),
      finalReport: this.finalReport?.slice(0, 500)
    };
  }

  // Fuller payload for the drill-down detail view: the whole recent activity
  // timeline (tool calls, thinking, notes) and the untruncated report,
  // instead of the last-5-lines preview getStatus() uses for the list.
  getDetail() {
    return {
      id: this.id,
      description: this.description,
      prompt: this.prompt,
      status: this.status,
      question: this.question,
      remainingMs: this.remainingMs,
      remainingMin: this.remainingMin,
      createdAt: this.createdAt,
      model: this.modelOverride || null,
      role: this.role,
      mode: this.mode,
      scratchpad: this.scratchpad || '',
      toolCalls: this._toolCalls,
      log: this.log.slice(-300),
      finalReport: this.finalReport || '',
    };
  }
}

class FocusManager {
  constructor(agentRefs) {
    this.agentRefs = {
      provider: agentRefs.provider,
      cfg: agentRefs.cfg,
      cwd: agentRefs.cwd,
      mcpServers: agentRefs.mcpServers,
      contextResolver: agentRefs.contextResolver || null,
      toolCtx: null // will be set by Agent after toolCtx is created
    };
    this.sessions = new Map(); // id -> FocusSession
    this.board = board;
    this._eventHandler = null;
  }

  onEvent(fn) {
    this._eventHandler = fn;
  }

  setToolCtx(toolCtx) {
    this.agentRefs.toolCtx = toolCtx;
  }

  emit(event, ...args) {
    if (this._eventHandler) {
      try { this._eventHandler(event, ...args); } catch {}
    }
  }

  spawn({ description, prompt, minutes = 30, model, role, mode }) {
    const deadlineMs = Math.max(1, minutes) * 60 * 1000;
    const id = genId();
    const session = new FocusSession({
      id,
      manager: this,
      description,
      prompt,
      deadlineMs,
      agentRefs: this.agentRefs,
      modelOverride: model,
      role,
      mode
    });
    this.sessions.set(id, session);
    this.emit('start', session);
    session.run().catch(err => {
      session.addLog(`fatal error: ${err.message}`);
      session.finish(`Error: ${err.message}`, 'error');
    });
    return { id, description, minutes, model, role, mode };
  }

  get(id) {
    return this.sessions.get(id);
  }

  list() {
    return Array.from(this.sessions.values()).map(s => s.getStatus());
  }

  getDetail(id) {
    const s = this.sessions.get(id);
    return s ? s.getDetail() : null;
  }

  answer(id, answer) {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'waiting') return { ok: false, error: 'No waiting session' };
    s.resume(answer);
    return { ok: true };
  }

  cancel(id) {
    const s = this.sessions.get(id);
    if (!s) return { ok: false };
    s.abort.abort();
    return { ok: true };
  }
}

module.exports = { FocusManager, FocusSession, FocusBoard, board };

function parseToolArgs(str) {
  if (!str) return {};
  const cleaned = String(str).trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    let normalized = cleaned;
    normalized = normalized.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (m, p1) => {
      return '"' + p1.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
    });
    normalized = normalized.replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(normalized);
    } catch (err2) {
      throw new Error(`Failed to parse arguments: ${err2.message}. Raw: ${str}`);
    }
  }
}