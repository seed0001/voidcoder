// The agent loop: streaming, tool execution with permission gates, context
// compaction, subagents, usage tracking.

const { streamChat, complete, extractToolCallsFromText } = require('./providers');
const { buildSystemPrompt } = require('./prompt');
const { resolveProvider } = require('./config');
const toolRegistry = require('./tools');
const costTracker = require('./costTracker');
const { FocusManager } = require('./focus');
const { AgentRoles } = require('./agentRoles');
const guardrails = require('./guardrails');
const { discoverModels } = require('./modelCatalog');
const { createContextService } = require('./contextDb');
const { makeOrganism } = require('./organism');
const { buildContinuationPacket, describePlanStep, describeRemainingSteps, clip } = require('./continuationPacket');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const estTokens = (messages) => Math.ceil(JSON.stringify(messages).length / 3.6);

// Errors worth retrying automatically: dropped/stalled connections, rate
// limits, provider 5xx. Anything else (auth, bad request, user abort) is not.
function isTransientNetError(err) {
  const m = String(err?.message || '');
  return /fetch failed|stalled|terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket|network|HTTP (408|429|5\d\d)/i.test(m);
}

class Agent {
  constructor({ cfg, provider, session, permissions, mcpServers = [], events = {}, cwd = process.cwd(), streamChatFn = null, suggestFailoverModelFn = null }) {
    this.cfg = cfg;
    this.provider = provider;
    this.session = session;
    if (this.session && !Array.isArray(this.session.contextTraces)) this.session.contextTraces = [];
    this.permissions = permissions;
    this.mcpServers = mcpServers;
    // events: onDelta, onToolStart, onToolEnd, onTodos, onStatus, onSubagentStart, onSubagentEnd
    this.events = events;
    this.streamChatFn = streamChatFn || streamChat;
    // Overridable for tests (avoids a live OpenRouter catalog fetch) — see
    // the model-collapse recovery block in _loop().
    this.suggestFailoverModelFn = suggestFailoverModelFn || require('./modelCatalog').suggestFailoverModel;
    this.abort = null;
    this.cwd = cwd;
    // Optional SQL context service — must never take down the agent if the
    // database driver can't load (missing dependency, corrupt file, etc.).
    try {
      this.contextService = cfg.contextService || createContextService(cfg, cwd);
    } catch (err) {
      this.contextService = { repository: null, resolver: null, enabled: false, error: { code: err.code || 'driver', message: err.message } };
    }
    this.contextResolver = this.contextService.resolver || null;
    this.contextInitialized = false;

    // Two-sided agent. In 'split' mode this Agent is the CHAT side: no tools,
    // a big conversation window, and plain-text delegation of any real work to
    // the worker side (which holds the full rules, toolset and tight budget).
    this.mode = cfg.agentMode === 'legacy' ? 'legacy' : 'split';
    this.baseProviderContext = provider.contextTokens;
    this.chatLimit = provider.contextTokens || cfg.contextTokens || 200000;
    this.workerProvider = provider;
    this.refreshProviders();

    this.focus = new FocusManager({
      provider,
      cfg,
      cwd,
      mcpServers,
      contextResolver: this.contextResolver,
      toolCtx: null
    });
    this.focus.onEvent((event, ...args) => {
      this.events[`onFocus${event.charAt(0).toUpperCase() + event.slice(1)}`]?.(...args);
    });

    this.roles = new AgentRoles(cwd);

    // Optional digital-organism mode: a persistent treasury, auditable ledger,
    // per-task budgets and cost-aware model routing. Null when disabled, so
    // every downstream guard is a simple `if (this.organism)` no-op.
    this.organism = makeOrganism(cfg, cwd);
    if (this.organism) this.organism.initialize().catch(() => {});
    // Share the organism with the focus manager so background focus sessions
    // can charge the same treasury and stay under the same budget rules.
    this.focus.agentRefs.organism = this.organism;

    this.toolCtx = {
      cwd,
      shellCwd: cwd,
      cfg: this.cfg,
      provider,
      onFileChange: (file, before, after) => {
        this.session.recordFileChange(file, before, after);
        this.events.onFileChange?.(file, before, after);
      },
      onTodos: (todos) => this.events.onTodos?.(todos),
      runSubagent: (args) => this.runSubagent(args),
      focus: this.focus,
      roles: this.roles,
      organism: this.organism,
      setModel: (modelId) => this.setModel(modelId),
      contextResolver: this.contextResolver,
      onContextTrace: (trace) => this.recordContextTrace(trace),
      agentKind: 'main',
    };
    this.focus.setToolCtx(this.toolCtx);
    if (this.mode === 'split') {
      // Chat side: no tool definitions, no executors. Work is delegated.
      this.tools = { apiDefs: [], executors: {} };
    } else {
      // Legacy monolith: full toolset inline.
      this.tools = toolRegistry.build(this.toolCtx, { mcpServers, includeTask: true, includeFocus: true, includeModel: true });
    }
  }

  recordContextTrace(trace) {
    if (!trace) return;
    if (this.session && Array.isArray(this.session.contextTraces)) this.session.contextTraces.push(trace);
    this.events.onContextTrace?.(trace);
  }

  async resolveContext(task, agentKind = 'main') {
    if (!this.contextResolver) return null;
    if (!this.contextInitialized) {
      try { await this.contextService.repository.initialize(); }
      catch (err) {
        this.contextInitialized = true;
        const trace = { traceId: require('crypto').randomUUID(), agentKind, task: String(task), retrievedAt: new Date().toISOString(), recordsRetrieved: [], recordsInjected: [], recordsOmitted: [], relationships: [], estimatedTokens: 0, budgetTokens: this.cfg.contextDb?.budgetTokens || 6000, status: 'unavailable', errors: [{ code: err.code || 'initialization', message: err.message }], lookupDurationMs: 0, assemblyDurationMs: 0 };
        this.recordContextTrace(trace);
        return { schemaVersion: 1, status: 'unavailable', mandatoryContextComplete: true, budgetTokens: trace.budgetTokens, estimatedTokens: 0, instructions: [], rules: [], procedures: [], actions: [], validations: [], fallbacks: [], knowledge: [], records: [], relationships: [], provenance: [], trace };
      }
      this.contextInitialized = true;
    }
    const pkg = await this.contextResolver.resolve({ task, agentKind });
    this.recordContextTrace(pkg.trace);
    return pkg;
  }

  // Recompute the two context budgets and worker provider after cfg/provider
  // changes (constructor, /model, setModel, app settings). A zero configured
  // limit means automatic model-aware detection; explicit limits remain wins.
  refreshProviders() {
    const cfg = this.cfg;
    const configuredChat = cfg.chatContextTokens || cfg.contextTokens || this.provider.configuredContextTokens || 0;
    const detectedChat = this.provider.modelContextTokens || this.provider.contextTokens || 0;
    if (this.mode === 'legacy') {
      this.chatLimit = configuredChat || detectedChat || 200000;
      this.provider.contextTokens = this.chatLimit;
      this.workerProvider = this.provider;
      return;
    }
    this.chatLimit = configuredChat || detectedChat || 200000;
    this.provider.contextTokens = this.chatLimit;
    if (cfg.workerModel) {
      try { this.workerProvider = resolveProvider(cfg, cfg.workerModel); } catch { this.workerProvider = null; }
    }
    if (!this.workerProvider) {
      this.workerProvider = { ...this.provider };
      this.workerProvider.contextTokens = this.baseProviderContext || this.provider.modelContextTokens || this.provider.configuredContextTokens || cfg.contextTokens || 200000;
    }
    if (cfg.workerContextTokens) this.workerProvider.contextTokens = cfg.workerContextTokens;
  }

  async hydrateModelContext(provider = this.provider) {
    // Local providers already receive their configured num_ctx. OpenRouter's
    // live catalog is the authoritative source for remote model windows.
    if (!provider || provider.name !== 'openrouter' || this.cfg.contextTokens || this.cfg.chatContextTokens || provider.configuredContextTokens) return;
    try {
      const { discoverModels: discoverLiveModels } = require('./modelCatalog');
      const models = await discoverLiveModels(this.cfg, this.cwd);
      const entry = models.find((m) => m.provider === 'openrouter' && m.modelName === provider.model);
      if (entry?.contextTokens > 0) provider.modelContextTokens = entry.contextTokens;
    } catch { /* catalog is best-effort; retain safe fallback */ }
  }

// Switch the agent's model at runtime. modelId may be a registry id
  // ("openrouter-deepseek"), a provider/model string, or a family name.
  async setModel(modelId) {
    const { resolveProvider, saveGlobal, ModelRegistry } = require('./config');
    const { resolveModelString } = require('./modelCatalog');
    let modelString = modelId;

    if (String(modelId).includes('/')) {
      modelString = modelId; // already provider/model syntax
    } else {
      const registry = new ModelRegistry(this.cwd || process.cwd());
      const entry = registry.get(modelId);
      if (entry) {
        modelString = `${entry.provider}/${entry.modelName}`;
      } else {
        const resolved = await resolveModelString(this.cfg, this.cwd || process.cwd(), modelId).catch(() => null);
        if (!resolved) {
          const registryList = registry.getAll();
          const available = [...new Set([...registryList.map((m) => m.id), ...registryList.map((m) => m.modelName)])].slice(0, 40).join(', ');
          return { ok: false, error: `Unknown model id "${modelId}". Resolve a name with list_models, or use one of: ${available}` };
        }
        modelString = resolved;
      }
    }

    const newProvider = resolveProvider(this.cfg, modelString);
    this.provider = newProvider;
    this.focus.agentRefs.provider = newProvider;
    await this.hydrateModelContext(this.provider);
    if (this.roles) this.roles.setRole('main', modelString);
    // Refresh the two-sided budgets; rebuild tools only in legacy monolith mode
    // (the chat side stays tool-less by design).
    this.refreshProviders();
    if (this.mode === 'legacy') {
      this.tools = toolRegistry.build(this.toolCtx, { mcpServers: this.mcpServers, includeTask: true, includeFocus: true, includeModel: true });
    }
    try {
      const saved = { provider: newProvider.name, model: newProvider.model };
      saveGlobal(saved);
    } catch {}
    return { ok: true, provider: newProvider, id: modelId };
  }

  stop() {
    this.abort?.abort();
  }

  smallProvider() {
    if (!this.cfg.smallModel) return this.provider;
    try {
const { resolveProvider, saveGlobal, ModelRegistry } = require('./config');
      return resolveProvider(this.cfg, this.cfg.smallModel);
    } catch { return this.provider; }
  }

  // ---- context compaction -------------------------------------------------

  needsCompaction(systemPromptTokens = 0) {
    const limit = this.chatLimit;
    // Fixed overhead (system prompt + tool defs) alone can exceed the 75%
    // budget on small windows. Only ever compact when the HISTORY is genuinely
    // large — otherwise compaction would fire before nearly every send and
    // destroy the conversation (this is what read as total amnesia).
    const historyTokens = estTokens(this.session.messages);
    if (historyTokens < limit * 0.15) return false;
    return historyTokens + systemPromptTokens > limit * this.cfg.compactAt;
  }

  async compact() {
    const msgs = this.session.messages;
    if (msgs.length < 6) return false;
    const keepTail = 4;
    const toSummarize = msgs.slice(0, msgs.length - keepTail);
    const tail = msgs.slice(-keepTail);
    this.events.onStatus?.('compacting context…');
    const transcript = toSummarize.map((m) => {
      const role = m.role;
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const tools = m.tool_calls ? ` [called: ${m.tool_calls.map((t) => t.function.name).join(', ')}]` : '';
      return `${role}${tools}: ${String(content).slice(0, 2000)}`;
    }).join('\n');

    const limit = this.chatLimit;
    const isSmallCtx = limit <= 8192;
    const maxSummaryWords = isSmallCtx ? 250 : 1500;
    const maxSummaryTokens = isSmallCtx ? 400 : 3000;

    const summary = await complete(this.smallProvider(), [
      { role: 'system', content: `Summarize this coding-agent conversation for context continuation. Preserve: the original task and constraints, all file paths touched and what changed in them, key decisions, current state, and what remains to be done. Be dense and factual. Under ${maxSummaryWords} words.` },
      { role: 'user', content: transcript.slice(0, 300000) },
    ], { maxTokens: maxSummaryTokens });

    // Pin the session-opening user message verbatim. Small/weak summary models
    // routinely drop the task itself, which then reads as total amnesia.
    const firstUser = msgs.find((m) => m.role === 'user' && typeof m.content === 'string');
    const pinned = firstUser && !tail.some((m) => m === firstUser) ? [firstUser] : [];

    this.session.messages = [
      ...pinned,
      { role: 'user', content: `[Conversation compacted. Summary of everything so far:]\n\n${summary}` },
      { role: 'assistant', content: 'Understood — continuing from that state.' },
      ...tail.filter((m) => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls && typeof m.content === 'string')),
    ];
    this.session.save();
    return true;
  }

  // ---- subagents ----------------------------------------------------------

  async runSubagent({ description, prompt }) {
    this.events.onSubagentStart?.(description || 'subagent');
    const subTools = toolRegistry.build({
      cwd: this.toolCtx.cwd,
      shellCwd: this.toolCtx.shellCwd,
      cfg: this.cfg,
      provider: this.provider,
      onFileChange: this.toolCtx.onFileChange,
      onTodos: () => { },
      contextResolver: this.contextResolver,
      onContextTrace: (trace) => this.recordContextTrace(trace),
      agentKind: 'subagent',
    }, { mcpServers: this.mcpServers, includeTask: false, includeFocus: false });

    const messages = [{ role: 'user', content: prompt }];

    // Digital-organism mode: when enabled, route the subagent to the cheapest
    // adequate model for its workload rather than inheriting the main model.
    // Explicit caller intent (cfg.workerModel) still wins.
    let subProvider = this.workerProvider || this.provider;
    if (this.organism) {
      try {
        const { resolveProvider } = require('./config');
        const choice = await this.organism.selectModel({
          task: prompt,
          difficulty: null,
          capability: null,
        });
        if (choice.model && !this.cfg.workerModel) {
          subProvider = resolveProvider(this.cfg, choice.model);
        }
      } catch { /* fall back to the inherited provider */ }
    }
    const subLimit = subProvider.contextTokens || this.cfg.contextTokens || 200000;
    const databaseContext = await this.resolveContext(prompt, 'subagent');
    const result = await this._loop(messages, subTools, {
      systemPrompt: buildSystemPrompt({ cwd: this.toolCtx.cwd, subagent: true, contextTokens: subLimit, databaseContext }),
      maxRounds: 50,
      quiet: true,
      kind: 'subagent',
      taskLabel: description ? `subagent: ${description}` : prompt,
      provider: subProvider,
      allowsHandoff: false,
      organismTask: `subagent: ${description || 'task'}`,
    });
    this.events.onSubagentEnd?.(description || 'subagent', result);
    return result || '(subagent returned nothing)';
  }

  // The action side of the two-sided agent: a bounded, tool-calling session with
  // its own limited context, full toolset and the hardened rules. The chat agent
  // delegates plain-text tasks here and relays the returned report.
  async runWorker(task, { context = '', streamTools = true, images = [] } = {}) {
    if (images.length) await assertVisionModel(this.workerProvider || this.provider, this.toolCtx.cwd);
    // Digital-organism mode: route the worker to the cheapest adequate model
    // unless cfg.workerModel explicitly says otherwise.
    let workerProvider = this.workerProvider || this.provider;
    if (this.organism && !this.cfg.workerModel) {
      try {
        const { resolveProvider } = require('./config');
        const choice = await this.organism.selectModel({ task, difficulty: null });
        if (choice.model) workerProvider = resolveProvider(this.cfg, choice.model);
      } catch { /* inherit the configured worker provider */ }
    }
    const workerLimit = workerProvider.contextTokens || this.cfg.contextTokens || 200000;
    const workerTools = toolRegistry.build(this.toolCtx, {
      mcpServers: this.mcpServers, includeTask: true, includeFocus: false,
    });
    const databaseContext = await this.resolveContext(task, 'worker');
    const systemPrompt = buildSystemPrompt({ cwd: this.toolCtx.cwd, worker: true, contextTokens: workerLimit, databaseContext });
    this.events.onSubagentStart?.('work: ' + String(task).slice(0, 80));
    const workText = `# Work request from the chat agent\n\n${task}${context ? `\n\n# Context passed by the chat agent\n${context}` : ''}`;
    const messages = [{
      role: 'user',
      content: images.length
        ? [{ type: 'text', text: workText }, ...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } }))]
        : workText,
    }];
    try {
      const result = await this._loop(messages, workerTools, {
        systemPrompt,
        maxRounds: this.cfg.maxToolRounds,
        quiet: true,
        streamTools,
        kind: 'work',
        provider: workerProvider,
        allowsHandoff: false,
        organismTask: 'work: ' + String(task).slice(0, 120),
        taskLabel: task,
      });
      this.events.onSubagentEnd?.('work', result);
      return result || '(worker completed with no report)';
    } catch (err) {
      this.events.onSubagentEnd?.('work', String(err.message));
      return `WORKER ERROR: ${err.message}`;
    }
  }

  async generateScratchpad() {
    const transcript = this.session.messages
      .slice(-15)
      .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 500) : ''}`)
      .join('\n');

    const prompt = [
      { role: 'system', content: 'You are a cognitive processor. Read the chat history and update the scratchpad. Keep it to exactly 2-3 bullet points representing: 1) Active Goal, 2) Current Status/Findings, 3) Immediate Next Step. Be extremely concise. Respond in English only. Under 80 words.' },
      { role: 'user', content: `Current Scratchpad:\n${this.session.scratchpad || 'None'}\n\nRecent History:\n${transcript}` }
    ];
    
    const summary = await complete(this.smallProvider(), prompt, { maxTokens: 150 });
    return summary.trim();
  }

  // ---- main entry ---------------------------------------------------------

  async send(userInput, { autonomous = false, organismTask = null } = {}) {
    const sendStarted = Date.now();
    await this.hydrateModelContext(this.provider);
    this.refreshProviders();
    if (this.mode === 'split' && this.workerProvider) {
      await this.hydrateModelContext(this.workerProvider);
      if (!this.cfg.workerContextTokens) {
        this.workerProvider.contextTokens = this.workerProvider.modelContextTokens || this.workerProvider.contextTokens || this.cfg.contextTokens || 200000;
      }
    }
    const input = normalizeUserInput(userInput);
    if (input.images.length) await assertVisionModel(this.provider, this.toolCtx.cwd);
    const userContent = input.images.length
      ? [{ type: 'text', text: input.text }, ...input.images.map((image) => ({
        type: 'image_url', image_url: { url: image.dataUrl },
      }))]
      : input.text;
    this.session.messages.push({ role: 'user', content: userContent });
    if (!this.session.title) {
      this.session.title = input.text.replace(/\s+/g, ' ').slice(0, 60) || 'Image analysis';
    }

    // Update scratchpad every 3 turns (or if empty and we have history)
    if (this.session.messages.length >= 2 && (this.session.usage.turns % 3 === 0 || !this.session.scratchpad)) {
      try {
        this.session.scratchpad = await this.generateScratchpad();
      } catch (err) {
        // best-effort
      }
    }

    const split = this.mode === 'split';
    const databaseContext = await this.resolveContext(input.text, 'main');
    const systemPrompt = buildSystemPrompt({
      cwd: this.toolCtx.cwd,
      autonomous,
      scratchpad: this.session.scratchpad,
      contextTokens: this.chatLimit,
      side: split ? 'chat' : null,
      databaseContext,
    });
    const sysPromptTokens = estTokens([{ role: 'system', content: systemPrompt }]);
    const toolTokens = estTokens(this.tools.apiDefs);

    if (this.needsCompaction(sysPromptTokens + toolTokens)) {
      try { await this.compact(); } catch { /* compaction is best-effort */ }
    }
    const result = await this._loop(this.session.messages, this.tools, {
      systemPrompt,
      maxRounds: this.cfg.maxToolRounds,
      autonomous,
      allowsHandoff: split,
      organismTask,
      taskLabel: organismTask || input.text,
    });
    this.session.usage.turns += 1;
    this.session.usage.activeTimeMs += Date.now() - sendStarted;
    this.session.save();
    // Rebuild project-level cost/time aggregate from all session files
    try { costTracker.rebuildFromSessions(this.toolCtx.cwd); } catch { /* best-effort */ }
    return result;
  }

  // ---- the loop -----------------------------------------------------------

  async _loop(messages, tools, { systemPrompt, maxRounds, autonomous = false, quiet = false, kind = 'main', provider = null, streamTools = false, allowsHandoff = false, organismTask = null, taskLabel = null }) {
    // Save/restore the abort controller so subagents don't clobber the parent.
    const prevAbort = this.abort;
    const abort = (this.abort = new AbortController());
    // This loop's provider: a worker/subagent override, or the chat provider.
    // Reassignable — a detected model collapse (see below) swaps it mid-loop.
    let prov = provider || this.provider;
    const showTools = !quiet || !!streamTools;
    let finalText = '';
    let proseNudges = 0;

    // Continuation state for this _loop invocation. Tracks what actually
    // happened so that if the model ever comes back with neither content nor
    // a tool call (a real, observed provider quirk right after a tool round),
    // we can hand it a structured continuation packet instead of a blank or
    // fake user turn. `pendingContinuation` is consumed once, spliced only
    // into the ephemeral request copy — it is NEVER pushed into `messages`,
    // so it never pollutes the persisted session/subagent/worker history.
    const completedWork = [];
    let lastToolCall = null; // { name, args }
    let lastToolResult = null; // { ok, output }
    let emptyRetries = 0;
    let pendingContinuation = null;
    const MAX_EMPTY_RETRIES = 2;

    // Model-collapse recovery (see guardrails.detectRepetitionCollapse):
    // models this _loop invocation has already caught degenerating, so a
    // failover never suggests the same bad model twice, and a bound on how
    // many times we'll swap models in one turn rather than flailing forever
    // if several sibling models are all unhealthy.
    const collapsedModelIds = new Set();
    let collapseRetries = 0;
    const MAX_COLLAPSE_RETRIES = 2;

    // Digital-organism mode: establish a per-task spending budget and a loop
    // guard ONCE per _loop invocation. Every model round below feeds it, and it
    // throws a special error to stop unproductive / overspending loops.
    let orgGuard = null;
    let orgKind = 'model_call';
    if (this.organism) {
      try {
        const difficulty = kind === 'subagent' || kind === 'work' ? 3
          : kind === 'focus' ? 3 : null;
        const budget = this.organism.budgetFor({ difficulty });
        orgGuard = this.organism.makeLoopGuard(budget);
        orgKind = kind === 'subagent' ? 'subagent' : kind === 'work' ? 'work' : kind === 'focus' ? 'focus' : organismTask ? 'scheduled' : 'model_call';
      } catch { orgGuard = null; }
    }
    // Names of every tool this agent can call, for prose-tool-call detection.
    const toolNames = new Set();
    if (tools && tools.executors) for (const k of Object.keys(tools.executors)) toolNames.add(k);
    if (tools && Array.isArray(tools.apiDefs)) {
      for (const d of tools.apiDefs) { const n = d && d.function && d.function.name; if (n) toolNames.add(n); }
    }

    try {
    for (let round = 0; round < maxRounds; round++) {
      const repeatGuard = guardrails.repeatedToolCallStreak(messages);
      const repeatStopAt = this.cfg.guardrails?.repeatedToolCallStopAt || 4;
      if (repeatGuard.count >= repeatStopAt) {
        throw new Error(`Repeated tool-call loop stopped safely: ${repeatGuard.name || 'the same tool'} was called ${repeatGuard.count} consecutive times with identical arguments. The tool may not have fired or its response may be missing/unchanged.`);
      }
      let result;
      let useTools = tools;

      // Pre-send budget guard: never let the provider silently trim our
      // conversation. Ollama/llama.cpp drop the OLDEST messages past num_ctx
      // instead of erroring, so an oversized send reads as amnesia on the next
      // turn. Compact (main session) or trim (subagent buffer) BEFORE sending.
      const limit = prov.contextTokens || this.cfg.contextTokens || 200000;
      const sysToolToks = estTokens([{ role: 'system', content: systemPrompt }]) + estTokens(useTools ? useTools.apiDefs : []);
      if (sysToolToks + estTokens(messages) > limit * 0.9) {
        if (messages === this.session.messages) {
          let compacted = false;
          try { compacted = await this.compact(sysToolToks); } catch { /* best-effort */ }
          if (compacted) messages = this.session.messages;
        } else if (messages.length > 10) {
          messages = [messages[0], ...messages.slice(-8)];
        }
      }

      for (let attempt = 0; ; attempt++) {
        try {
          const messagesToSend = [...messages];
          if (messagesToSend.length > 0) {
            const additions = guardrails.intercept({
              messages,
              kind,
              context: { cfg: this.cfg, cwd: this.toolCtx.cwd },
            });
            for (const addition of additions) {
              messagesToSend.push({ role: 'system', content: addition });
            }
          }
          // One-shot structured continuation packet (see below): consumed
          // here so the retry the model sees is anchored to real turn state,
          // never a blank "[continue]" or fabricated user message.
          if (pendingContinuation) {
            messagesToSend.push({ role: 'system', content: pendingContinuation });
            pendingContinuation = null;
          }
          result = await this.streamChatFn(prov,
            [{ role: 'system', content: systemPrompt }, ...messagesToSend],
            useTools ? useTools.apiDefs : null,
            {
              onDelta: quiet ? null : (t) => this.events.onDelta?.(t),
              onReasoningDelta: quiet ? null : (t) => this.events.onReasoningDelta?.(t),
              signal: abort.signal,
            });
          break;
        } catch (err) {
          const isContextError = /exceed.*context|context.*exceed|available context size|n_ctx/i.test(err.message);
          if (isContextError) {
            const match = err.message.match(/(?:context size|n_ctx)[^\d]*(\d+)/i);
            const detectedLimit = match ? parseInt(match[1], 10) : 4096;
            prov.contextTokens = detectedLimit;
            if (messages === this.session.messages) this.chatLimit = detectedLimit;
            if (showTools) this.events.onStatus?.(`detected actual context limit of ${detectedLimit} tokens; trimming and retrying…`);
            if (messages === this.session.messages) {
              const sysPromptTokens = estTokens([{ role: 'system', content: systemPrompt }]);
              const toolTokens = estTokens(useTools ? useTools.apiDefs : []);
              const compacted = await this.compact(sysPromptTokens + toolTokens);
              if (compacted) {
                messages = this.session.messages;
                attempt = -1; // reset to try again
                continue;
              }
              throw new Error(`Context limit of ${detectedLimit} tokens exceeded (unable to compact further).`);
            }
            // Non-session buffer (subagent / worker): trim instead of compacting.
            if (messages.length > 8) {
              messages = [messages[0], ...messages.slice(-6)];
              attempt = -1;
              continue;
            }
            throw new Error(`Context limit of ${detectedLimit} tokens exceeded (unable to trim further).`);
          }
          const isJinjaError = (prov.name === 'ollama' || prov.name === 'llamacpp') &&
            /template|parser|Jinja|tool/i.test(err.message);
          if (isJinjaError && useTools) {
            if (showTools) this.events.onStatus?.('local model tool-template error; retrying without native tool calling…');
            useTools = null;
            continue;
          }
          if (abort.signal.aborted || attempt >= 2 || !isTransientNetError(err)) throw err;
          if (showTools) this.events.onStatus?.(`connection problem (${String(err.message).slice(0, 120)}) — retrying ${attempt + 1}/2…`);
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
      if (showTools) this.events.onStatus?.('');

      // Defense in depth: strip any internal harness tag the model echoed
      // back verbatim (guardrail rules, continuation packets) before this
      // text is persisted, streamed further, or parsed for a handoff block.
      // The instructions above tell the model never to do this; this only
      // catches a model that still does, without touching normal prose.
      if (typeof result.content === 'string' && result.content) {
        result.content = guardrails.stripLeakedSystemTags(result.content);
      }

      if (result.usage) {
        this.session.usage.input += result.usage.prompt_tokens || 0;
        this.session.usage.output += result.usage.completion_tokens || 0;
        // OpenRouter sends total_cost in usage; local models don't.
        if (typeof result.usage.total_cost === 'number') {
          this.session.usage.cost += result.usage.total_cost;
        }

        // Digital-organism mode: debit the treasury for this model call and
        // feed the loop guard. Charging is best-effort and must never break the
        // agent when the catalog or ledger is unavailable — a real failure to
        // settle a charge (insufficient funds / budget breach) SHOULD stop the
        // loop so the organism reports a clear, auditable reason.
        if (this.organism && orgGuard) {
          try {
            const costUSD = typeof result.usage.total_cost === 'number'
              ? result.usage.total_cost
              : await this.organism._computeCallCost(prov, result.usage);
            const progress = result.toolCalls.length > 0 || (result.content && result.content.trim());
            orgGuard.chargeRound(costUSD, { progress });
            await this.organism.charge({
              costUSD,
              model: prov ? `${prov.name}/${prov.model}` : null,
              input: result.usage.prompt_tokens || 0,
              output: result.usage.completion_tokens || 0,
              kind: orgKind,
              actor: this.toolCtx.agentKind || 'main',
              task: organismTask || (this.session && this.session.title) || kind,
            });
          } catch (err) {
            if (err.organismBudgetStop || /Insufficient treasury balance/.test(err.message)) throw err;
            // Transient (e.g. catalog/pricing fetch failed) — don't stop the loop.
          }
        }
      }

      // Model collapse detection: some models occasionally degenerate into a
      // tight loop over a handful of words/phrases (sometimes drifting into
      // a language unrelated to the conversation) instead of a real answer —
      // a sampling/provider fault, not a real turn. Treat it as one: switch
      // to a similarly-priced sibling model on the same provider and retry
      // this round, rather than persisting the garbage or continuing to
      // spend on a model that just proved broken.
      if (typeof result.content === 'string' && result.content) {
        const collapse = guardrails.detectRepetitionCollapse(result.content);
        if (collapse) {
          const failedId = `${prov.name}/${prov.model}`;
          collapsedModelIds.add(failedId);
          const detail = collapse.kind === 'vocabulary'
            ? `only ${collapse.uniqueWords} unique words across ${collapse.totalWords}`
            : `"${collapse.gram}" repeated ${collapse.count}x`;
          if (showTools) this.events.onStatus?.(`model collapse on ${failedId} (${detail}) — looking for a similarly-priced alternative…`);
          try {
            guardrails.recordLesson({
              title: `${failedId} output collapse`,
              trigger: failedId,
              behavior: 'This model has degenerated into repetitive garbage output before under this harness. Prefer switching to an alternate model of similar cost if it happens again.',
              category: 'all',
              maxLearnings: this.cfg.guardrails?.maxLearnings || 30,
            });
          } catch { /* best-effort */ }

          let switched = false;
          if (collapseRetries < MAX_COLLAPSE_RETRIES) {
            collapseRetries++;
            try {
              const alt = await this.suggestFailoverModelFn(this.cfg, this.toolCtx.cwd, failedId, { excludeIds: [...collapsedModelIds] });
              if (alt) {
                const altId = `${alt.provider}/${alt.modelName}`;
                const { resolveProvider, saveGlobal } = require('./config');
                const altProvider = resolveProvider(this.cfg, altId);
                prov = altProvider;
                switched = true;
                // Main chat-side turn only (no explicit worker/subagent
                // override) — make the swap stick for the rest of the
                // session too. A subagent/worker/focus collapse should not
                // silently change the user's own main model.
                if (!provider) {
                  this.provider = altProvider;
                  try { saveGlobal({ provider: altProvider.name, model: altProvider.model }); } catch { /* best-effort */ }
                }
                if (showTools) this.events.onStatus?.(`switched to ${altId} after model collapse — retrying…`);
              } else if (showTools) {
                this.events.onStatus?.(`no alternate model available in ${failedId}'s price range; continuing on the same model.`);
              }
            } catch (err) {
              if (showTools) this.events.onStatus?.(`could not switch models after collapse: ${err.message}`);
            }
          }
          if (switched) continue; // retry this round on the new model
          // Retries exhausted or no alternate found: fall through and treat
          // the collapsed text as this round's answer rather than looping
          // forever chasing a replacement that isn't there.
        }
      }

      if (!result.toolCalls.length) {
        if (!result.content || !result.content.trim()) {
          // Some providers/models emit an empty completion (no content, no
          // tool call) — observed in practice right after a tool round
          // (successful `read` calls, a failed `edit`), but ALSO on a fresh
          // turn before any tool has run yet (first round of a new user
          // message, subagent prompt, or worker handoff). Either way there is
          // SOME continuation state worth handing back — a prior tool call/
          // result this turn if one exists, otherwise just the active task —
          // so build a structured continuation packet instead of a blank/fake
          // user turn that forces the model to guess, or worse, a hard stop.
          const lastMsg = messages[messages.length - 1];
          const cameFromTool = lastMsg && lastMsg.role === 'tool';
          const haveAnchor = cameFromTool || !!lastToolCall;
          if (emptyRetries < MAX_EMPTY_RETRIES) {
            emptyRetries++;
            pendingContinuation = buildContinuationPacket({
              activeTask: taskLabel || organismTask || `${kind} turn`,
              planStep: describePlanStep(this.toolCtx?.todos),
              remainingSteps: describeRemainingSteps(this.toolCtx?.todos),
              previousIntendedAction: lastToolCall
                ? `${lastToolCall.name}(${clip(JSON.stringify(lastToolCall.args || {}), 200)})`
                : null,
              toolCalled: lastToolCall?.name || guardrails.lastToolName(messages) || null,
              toolResult: lastToolResult || (cameFromTool
                ? { ok: !/^(ERROR|DENIED|FAILED):/i.test(String(lastMsg.content || '')), output: lastMsg.content }
                : null),
              completedWork,
              expectedNextStep: lastToolResult && !lastToolResult.ok
                ? 'The last tool call failed or was denied. Do not repeat the identical call. Adjust the arguments, choose a different tool/approach, or explain the failure and ask if you are blocked.'
                : haveAnchor
                  ? 'Use the tool result above to decide the next concrete action toward the active task and continue.'
                  : 'Nothing has run yet this turn — respond to the active task above directly, either with a normal reply or a tool call. Do not return another empty completion.',
              stopConditions: [
                'If continuation state above is insufficient to determine a valid next action, say so plainly and stop rather than inventing one.',
                `${Math.max(0, maxRounds - round - 1)} tool round(s) remain in this turn.`,
              ],
            });
            continue;
          }
          // Retries exhausted: stop and report rather than let the model
          // invent its next action from nothing, or loop forever on blanks.
          const reason = haveAnchor
            ? `the model did not act on ${emptyRetries} structured continuation packet(s) after the "${lastToolCall?.name || 'last'}" tool call`
            : `the model returned ${emptyRetries + 1} consecutive empty completions with no tool call to anchor a continuation packet on`;
          throw new Error(`Model returned an empty response (${reason}). Stopping rather than guessing at the next action. Please retry or try a different model.`);
        }

        // Chat-side work handoff: the conversation agent has NO tools, so a
        // plain-text JSON block is its only way to act. Small models scribble
        // whatever tool name they know ({name:"bash"|"read"|"focus"|...}), so we
        // accept ANY recognized tool and route the call(s) to the worker — a
        // literal {"name":"work",...} block is treated as an explicit task.
        if (allowsHandoff && this.mode === 'split') {
          const knownTools = [...toolRegistry.allToolNames(), 'work'];
          const workCalls = extractToolCallsFromText(result.content, knownTools);
          if (workCalls.length) {
            messages.push({ role: 'assistant', content: result.content });
            finalText = '';
            const work = workCalls.find((c) => c.function.name === 'work');
            if (work) {
              let rawArgs = {};
              try { rawArgs = parseToolArgs(work.function.arguments || '{}') || {}; } catch { rawArgs = {}; }
              // Small models mangle the schema ({"--task": .., "-timeframe": ..})
              // or drop the task entirely. Normalize keys; when nothing usable is
              // found, fall back to the prose the chat agent wrote around the
              // block — that planning text IS the full task.
              const norm = {};
              for (const [k, v] of Object.entries(rawArgs)) {
                const key = String(k).replace(/^[-_#]+/, '').replace(/[^a-zA-Z]/g, '').toLowerCase();
                if (key && typeof v === 'string') norm[key] = v;
              }
              let task = norm.task || norm.prompt || norm.request || norm.command || norm.description || norm.mission || '';
              let context = norm.context || norm.info || norm.background || norm.additional || '';
              if (!task) {
                const prose = String(result.content || '')
                  .replace(/```json[\s\S]*?```/g, '')
                  .replace(/```[\s\S]*?```/g, '')
                  .trim();
                task = prose || String(result.content || '').trim() || 'Continue the conversation’s current task.';
              }
              if (showTools) this.events.onStatus?.(`handing work to the action agent…`);
              const images = inputImages(messages);
              messages.push({
                role: 'tool',
                tool_call_id: `work_${Date.now().toString(36)}`,
                content: String(await this.runWorker(task, { context, streamTools: showTools, images })),
              });
            } else {
              const details = workCalls
                .map((c) => `- ${c.function.name}(${c.function.arguments || '{}'})`)
                .join('\n');
              if (showTools) this.events.onStatus?.(`routing tool call(s) to the action agent…`);
              const images = inputImages(messages);
              messages.push({
                role: 'tool',
                tool_call_id: `work_${Date.now().toString(36)}`,
                content: String(await this.runWorker(`Execute these tool calls and report what happened:\n${details}`, { streamTools: showTools, images })),
              });
            }
            continue;
          }
        }

        // Prose tool-intro guard: the model "called" a tool by writing its name
        // as plain text (e.g. a response starting with "focus" then prose). No
        // JSON was parsed, so NO tool ran and there is genuinely no output to
        // work from — that is exactly why it blanks out. Nudge it to emit a
        // real JSON call; treat repeated failures as a plain answer, not a loop.
        const intro = guardrails.leadToolName(result.content, toolNames);
        if (intro && proseNudges < 2) {
          proseNudges++;
          if (!quiet) this.events.onStatus?.(`tool call "${intro}" was not recognized (prose, not JSON); nudging the model to emit a proper call…`);
          messages.push({
            role: 'user',
            content: `[tool call not recognized] Your previous message led with a tool name ("${intro}") but was not a parseable tool call, so no tool ran and there is no tool output to work from. If you meant to call ${intro}, emit EXACTLY one fenced json block containing {"name": "${intro}", "arguments": { ... } } and nothing else. Otherwise continue in plain text and do not mention tool names.`,
          });
          continue;
        }
        messages.push({ role: 'assistant', content: result.content });
        finalText = result.content;
        break;
      }

      messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });
      // Real progress this round — a fresh empty-completion budget applies
      // to any later blank turn later in this same _loop invocation.
      emptyRetries = 0;

      // Chat side emitted native tool calls anyway (models sometimes do even
      // with no tool defs). It has no executors — route the whole round to the
      // worker as a task rather than erroring on "unknown tool".
      if (allowsHandoff && this.mode === 'split') {
        const names = result.toolCalls.map((c) => c.function.name).join(', ');
        const details = result.toolCalls.map((c) => `- ${c.function.name}(${c.function.arguments || '{}'})`).join('\n');
        finalText = '';
        if (showTools) this.events.onStatus?.(`chat agent emitted tool call(s) ${names}; routing to the action agent…`);
        const images = inputImages(messages);
        messages.push({
          role: 'tool',
          tool_call_id: `work_${Date.now().toString(36)}`,
          content: String(await this.runWorker(`Execute these tool calls for me and report what happened:\n${details}`, { streamTools: showTools, images })),
        });
        continue;
      }

      for (const call of result.toolCalls) {
        if (abort.signal.aborted) break;
        const name = call.function.name;
        let args = {};
        let parseError = null;
        try {
          args = parseToolArgs(call.function.arguments || '{}');
        } catch (err) {
          parseError = err;
        }

        if (showTools) this.events.onToolStart?.(name, args);
        let output, ok = true;

        const executor = tools.executors[name];
        if (!executor) {
          ok = false;
          output = `ERROR: unknown tool "${name}"`;
        } else if (parseError) {
          ok = false;
          output = `ERROR: ${parseError.message}`;
        } else {
          try {
            const allowed = await this.permissions.check(name, args, { autonomous });
            if (!allowed) {
              ok = false;
              output = 'DENIED: the user did not permit this action. Do not retry it; adjust your approach or ask.';
            } else {
              output = await executor(args);
            }
          } catch (err) {
            ok = false;
            output = `ERROR: ${err.message}`;
          }
        }
        if (showTools) this.events.onToolEnd?.(name, args, ok, String(output));
        messages.push({ role: 'tool', tool_call_id: call.id, content: String(output) });
        // Record continuation state for the empty-completion recovery packet
        // (see above): what ran, whether it succeeded, and a running log of
        // completed work for this turn.
        lastToolCall = { name, args };
        lastToolResult = { ok, output: String(output) };
        completedWork.push(`${name}: ${ok ? 'ok' : 'failed'} — ${clip(String(output), 160)}`);
      }

      if (abort.signal.aborted) {
        messages.push({ role: 'user', content: '[Interrupted by user]' });
        break;
      }
    }
    } finally {
      this.abort = prevAbort;
    }
    return finalText;
  }
}

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

function inputImages(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.role === 'user' ? messages[i].content : null;
    if (!Array.isArray(content)) continue;
    return content.filter((part) => part?.type === 'image_url' && part.image_url?.url)
      .map((part) => ({ dataUrl: part.image_url.url }));
  }
  return [];
}

function normalizeUserInput(input) {
  if (typeof input === 'string') return { text: input, images: [] };
  if (!input || typeof input !== 'object') throw new Error('Message must be text or an image attachment payload.');
  const text = String(input.text || '').trim();
  const images = Array.isArray(input.images) ? input.images : [];
  if (!text && !images.length) throw new Error('Message text or an image is required.');
  if (images.length > 4) throw new Error('You can attach up to 4 images per message.');
  for (const image of images) {
    if (!image || !IMAGE_TYPES.has(String(image.mimeType || '').toLowerCase())) {
      throw new Error('Unsupported image type. Use PNG, JPEG, WebP, or GIF.');
    }
    const bytes = Number(image.bytes);
    if (!Number.isFinite(bytes) || bytes < 1 || bytes > MAX_IMAGE_BYTES) {
      throw new Error('Each image must be between 1 byte and 10 MB.');
    }
    const mimeType = String(image.mimeType || '').toLowerCase();
    if (typeof image.dataUrl !== 'string' || !image.dataUrl.startsWith(`data:${mimeType};base64,`)) {
      throw new Error('Invalid image data. Please attach the image again.');
    }
  }
  return { text, images };
}

async function assertVisionModel(provider, cwd) {
  if (provider.name !== 'openrouter') {
    throw new Error('Image analysis currently requires an OpenRouter vision model.');
  }
  const models = await discoverModels({ providers: { openrouter: provider, ollama: {}, llamacpp: {} } }, cwd);
  const id = `openrouter/${provider.model}`;
  const model = models.find((entry) => entry.id === id || (entry.provider === 'openrouter' && entry.modelName === provider.model));
  if (!model?.capabilities?.includes('vision')) {
    throw new Error(`The active model does not advertise image support. Choose an OpenRouter vision model first.`);
  }
}

module.exports = { Agent, estTokens, normalizeUserInput, buildContinuationPacket, describePlanStep, describeRemainingSteps };

