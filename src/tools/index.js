// Tool registry: assembles core tools + task (subagent) + MCP tools into
// OpenAI tool definitions and an executor map.

const fsTools = require('./fsTools');
const searchTools = require('./searchTools');
const bashTool = require('./bashTool');
const webTools = require('./webTools');
const todoTool = require('./todoTool');
const memoryTool = require('./memoryTool');
const scheduleTool = require('./scheduleTool');
const costTool = require('./costTool');
const contextTools = require('./contextTools');
const organismTool = require('./organismTool');
const mcp = require('../mcp');
const { FOCUS_DEFS, makeExecutors: makeFocusExecutors } = require('./focusTools');
const { MODEL_DEFS, makeExecutors: makeModelExecutors } = require('./modelTools');

const TASK_DEF = {
  name: 'task',
  description: 'Spawn a subagent for a self-contained subtask (research, multi-file search, an isolated change). It has the same tools (except task) and returns only its final report — use it to keep your own context small.',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'short label shown to the user' },
      prompt: { type: 'string', description: 'complete standalone instructions for the subagent' },
    },
    required: ['prompt'],
  },
};

function build(ctx, { mcpServers = [], includeTask = true, includeFocus = false, includeModel = false, includeContext = true } = {}) {
  // ctx: { cwd, shellCwd, onFileChange, onTodos, runSubagent, focus, setModel, provider, cfg }
  const provider = ctx.provider || {};
  const cfg = ctx.cfg || {};
  const limit = provider.contextTokens || cfg.contextTokens || 200000;
  const isSmallCtx = limit <= 8192;

  // If context is small, we keep requested tools enabled but rely on description compression to save space.
  let finalIncludeFocus = includeFocus;
  let finalIncludeModel = includeModel;

  const defs = [
    ...fsTools.defs,
    ...searchTools.defs,
    ...bashTool.defs,
    ...webTools.defs,
    ...todoTool.defs,
    ...memoryTool.defs,
    ...scheduleTool.defs,
    ...costTool.defs,
  ];
  if (includeContext && ctx.contextResolver) defs.push(...contextTools.CONTEXT_DEFS);
  const executors = {
    ...fsTools.makeExecutors(ctx),
    ...searchTools.makeExecutors(ctx),
    ...bashTool.makeExecutors(ctx),
    ...webTools.makeExecutors(ctx),
    ...todoTool.makeExecutors(ctx),
    ...memoryTool.makeExecutors(ctx),
    ...scheduleTool.makeExecutors(ctx),
    ...costTool.makeExecutors(ctx),
  };
  if (includeContext && ctx.contextResolver) Object.assign(executors, contextTools.makeExecutors(ctx));

  if (includeTask) {
    defs.push(TASK_DEF);
    executors.task = async ({ description, prompt }) => {
      if (!ctx.runSubagent) throw new Error('subagents unavailable in this context');
      return ctx.runSubagent({ description, prompt });
    };
  }

  if (finalIncludeFocus && ctx.focus) {
    for (const def of FOCUS_DEFS) defs.push(def);
    Object.assign(executors, makeFocusExecutors(ctx));
  }

  if (finalIncludeModel) {
    for (const def of MODEL_DEFS) defs.push(def);
    Object.assign(executors, makeModelExecutors(ctx));
  }

  const mcpDefs = mcp.toolDefs(mcpServers);
  for (const def of mcpDefs) {
    defs.push({ name: def.name, description: def.description, parameters: def.parameters });
    executors[def.name] = (args) => def._mcp.server.callTool(def._mcp.tool, args);
  }

  let apiDefs = defs.map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.parameters } }));

  if (isSmallCtx) {
    const shortDescriptions = {
      write: 'Write content to a file, creating parent directories if needed.',
      edit: 'Edit an existing file by replacing a contiguous block of text.',
      read: 'Read a range of lines from a text file.',
      glob: 'Find files matching a glob pattern relative to the workspace.',
      grep: 'Search for regex pattern matches in files or directories.',
      ls: 'List entries in a directory.',
      search: 'Search for text in the project.',
      bash: 'Run a shell command on the host machine.',
      webfetch: 'Fetch content of a URL as markdown.',
      websearch: 'Search the web (multi-engine fallback + retry).',
      search_repos: 'Search GitHub repos for code/tools.' ,
      search_packages: 'Search npm registry for packages.',
      search_news: 'Search Hacker News for fresh ideas.',
      rss_fetch: 'Fetch and parse an RSS/Atom feed.',
      todowrite: 'Write tasks checklist to plan work.',
      todotoggle: 'Toggle status of a task.',
      todolist: 'List all tasks in checklist.',
      project_memory: 'Read or write persistent project memory.',
      log_lesson: 'Record a behavioral lesson (if trigger then behavior).',
      list_lessons: 'List saved behavioral lessons.',
      cost_query: 'Query spending and active time stats.',
      schedule: 'Schedule a task or timer.',
      schedule_remove: 'Cancel a scheduled task.',
      schedule_show: 'Show details of scheduled tasks.',
      context_query: 'Search the context database for stored facts and rules.',
      context_topic_create: 'Create a research topic collection.',
      context_topic_list: 'List all context database topics.',
      context_topic_delete: 'Delete a topic and its records.',
      context_record_add: 'Add a fact/rule/procedure to a topic.',
      context_record_update: 'Update an existing context record.',
      context_record_delete: 'Delete a context record.',
      task: 'Spawn a background subagent to work on a subtask.',
      focus: 'Spawn background focus agent.',
      focus_status: 'Get background focus status.',
      focus_answer: 'Answer focus subagent question.',
      focus_board_read: 'Read shared board messages.',
      focus_board_write: 'Write shared board message.',
      list_models: 'List models in the registry.',
      model_info: 'Get details about a model.',
      current_model: 'Get the active model ID.',
      set_model: 'Switch the active model.',
      assign_model: 'Route a role or agent to a model.',
      agent_structure: 'Inspect agent model routing.',
      model_tiers: 'List models by cost tier (free/economy/average/premium/vision).',
      cost_estimate: 'Estimate project cost for a model.',
      recommend_models: 'Recommend models within a budget.',
    };

    apiDefs = apiDefs.map(d => {
      const fn = d.function;
      const shortDesc = shortDescriptions[fn.name];
      if (shortDesc) {
        return {
          ...d,
          function: {
            ...fn,
            description: shortDesc
          }
        };
      }
      return d;
    });
  }

  return {
    apiDefs,
    executors,
  };
}

// Every built-in tool name (core + task + focus + model). Used by the split
// chat side to recognize whatever tool name a small model scribbles into a
// plain-text JSON block, so it can be routed to the worker instead of being
// ignored and merely rendered as chat text.
function allToolNames() {
  return [
    ...fsTools.defs,
    ...searchTools.defs,
    ...bashTool.defs,
    ...webTools.defs,
    ...todoTool.defs,
    ...memoryTool.defs,
    ...scheduleTool.defs,
    ...costTool.defs,
    ...contextTools.CONTEXT_DEFS,
    ...FOCUS_DEFS,
    ...MODEL_DEFS,
    TASK_DEF,
  ].map((d) => d.name);
}

module.exports = { build, allToolNames };
