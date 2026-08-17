// Structured access to the optional context database — topic collections and
// records. The agent uses these during research to organize key facts, rules,
// and procedures into searchable topic "tables" that auto-inject into future
// turns via the context resolver.

const CONTEXT_DEFS = [
  {
    name: 'context_query',
    description: 'Query the context database for relevant records (facts, rules, procedures, knowledge). Read-only. Use this to recall what you or previous sessions already learned about a topic.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Task, topic, or situation to find relevant context for' },
        topic_id: { type: 'string', description: 'Optional: restrict results to a specific topic' },
        kinds: { type: 'array', items: { type: 'string' }, description: 'Optional record kinds: instruction, rule, procedure, action, validation, fallback, knowledge' },
        limit: { type: 'number', description: 'Maximum records to retrieve (default 40)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'context_topic_create',
    description: 'Create a new topic collection in the context database. Topics group related records — think of them as virtual research tables for a subject area (e.g. "Holloman AFB operations", "React performance patterns"). Returns the topic ID.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short name for the topic' },
        description: { type: 'string', description: 'What this topic covers and why it exists' },
      },
      required: ['title'],
    },
  },
  {
    name: 'context_topic_list',
    description: 'List all topic collections in the context database with their record counts. Use this to see what research areas already exist before creating a new one.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'context_topic_delete',
    description: 'Delete a topic collection AND all records inside it. Use when a research area is no longer relevant or was created by mistake.',
    parameters: {
      type: 'object',
      properties: { topic_id: { type: 'string', description: 'The topic ID to delete' } },
      required: ['topic_id'],
    },
  },
  {
    name: 'context_record_add',
    description: 'Add a fact, rule, procedure, or knowledge record to a topic in the context database. This is how you persist research findings so future turns and sessions can recall them automatically.',
    parameters: {
      type: 'object',
      properties: {
        topic_id: { type: 'string', description: 'Topic to add this record to (use context_topic_create first, or context_topic_list to find an existing one)' },
        kind: { type: 'string', description: 'Record kind: instruction, rule, procedure, action, validation, fallback, or knowledge', enum: ['instruction', 'rule', 'procedure', 'action', 'validation', 'fallback', 'knowledge'] },
        title: { type: 'string', description: 'Short label for this record' },
        summary: { type: 'string', description: 'One-line summary of what this record contains' },
        content: { description: 'The actual fact/rule/procedure data. Can be a string or a structured object.', type: ['string', 'object'] },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for searchability' },
        priority: { type: 'number', description: 'Priority for context injection (higher = more likely to be included). Default 0.' },
        source: { type: 'string', description: 'Where this information came from (URL, tool, file, etc.)' },
      },
      required: ['topic_id', 'kind', 'title', 'content'],
    },
  },
  {
    name: 'context_record_update',
    description: 'Update an existing context record (creates a new version). Use to correct or expand a previously stored fact/rule.',
    parameters: {
      type: 'object',
      properties: {
        record_id: { type: 'string', description: 'The record ID to update' },
        kind: { type: 'string', description: 'Updated record kind', enum: ['instruction', 'rule', 'procedure', 'action', 'validation', 'fallback', 'knowledge'] },
        title: { type: 'string', description: 'Updated title' },
        summary: { type: 'string', description: 'Updated summary' },
        content: { description: 'Updated content (string or object)', type: ['string', 'object'] },
        tags: { type: 'array', items: { type: 'string' }, description: 'Updated tags' },
        priority: { type: 'number', description: 'Updated priority' },
        source: { type: 'string', description: 'Updated source' },
      },
      required: ['record_id'],
    },
  },
  {
    name: 'context_record_delete',
    description: 'Delete a record from the context database. Use to remove outdated or incorrect facts.',
    parameters: {
      type: 'object',
      properties: {
        record_id: { type: 'string', description: 'The record ID to delete' },
        version: { type: 'string', description: 'Optional: delete only a specific version' },
      },
      required: ['record_id'],
    },
  },
];

function makeExecutors(ctx) {
  return {
    context_query: async ({ query, topic_id, kinds = [], limit } = {}) => {
      if (!ctx.contextResolver) return 'Context database is disabled or unconfigured.';
      try {
        // An explicit topic_id from the model always wins; otherwise default
        // to whatever container/topic is currently active (see Agent.setActiveTopic),
        // so a scoped session's manual queries stay scoped too, not just its
        // automatic per-turn context injection.
        const pkg = await ctx.contextResolver.resolve({ task: query, agentKind: ctx.agentKind || 'main', budgetTokens: ctx.contextBudgetTokens, kinds, topicId: topic_id || ctx.activeTopicId || null, maxRecords: limit });
        ctx.onContextTrace?.(pkg.trace);
        return JSON.stringify(pkg, null, 2);
      } catch (err) {
        return `Context query failed: ${err.message}`;
      }
    },

    context_topic_create: async ({ title, description }) => {
      if (!ctx.contextResolver?.repository) return 'Context database is disabled or unconfigured.';
      try {
        const topic = await ctx.contextResolver.repository.createTopic({ title, description: description || '' });
        return `Created topic "${title}" (id: ${topic.topicId}). Use this topic_id when adding records.`;
      } catch (err) {
        return `Failed to create topic: ${err.message}`;
      }
    },

    context_topic_list: async () => {
      if (!ctx.contextResolver?.repository) return 'Context database is disabled or unconfigured.';
      try {
        const topics = await ctx.contextResolver.repository.listTopics();
        if (!topics.length) return 'No topics exist yet. Use context_topic_create to start one.';
        return topics.map((t) =>
          `${t.topicId}  ${t.title}  (${t.recordCount} records)  ${t.description || ''}`
        ).join('\n');
      } catch (err) {
        return `Failed to list topics: ${err.message}`;
      }
    },

    context_topic_delete: async ({ topic_id }) => {
      if (!ctx.contextResolver?.repository) return 'Context database is disabled or unconfigured.';
      try {
        await ctx.contextResolver.repository.deleteTopic(topic_id);
        return `Deleted topic ${topic_id} and all its records.`;
      } catch (err) {
        return `Failed to delete topic: ${err.message}`;
      }
    },

    context_record_add: async ({ topic_id, kind, title, summary, content, tags, priority, source }) => {
      if (!ctx.contextResolver?.repository) return 'Context database is disabled or unconfigured.';
      try {
        const recordId = require('crypto').randomUUID();
        await ctx.contextResolver.repository.upsert({
          recordId, version: '1', kind, topicId: topic_id,
          title: title || '', summary: summary || '',
          content: content, tags: tags || [], source: source || '',
          priority: priority || 0, mandatory: false,
        });
        return `Added ${kind} record "${title}" (id: ${recordId}) to topic ${topic_id}.`;
      } catch (err) {
        return `Failed to add record: ${err.message}`;
      }
    },

    context_record_update: async ({ record_id, kind, title, summary, content, tags, priority, source }) => {
      if (!ctx.contextResolver?.repository) return 'Context database is disabled or unconfigured.';
      try {
        const existing = await ctx.contextResolver.repository.get(record_id);
        if (!existing) return `Record ${record_id} not found.`;
        const newVersion = String(Number(existing.version) + 1);
        await ctx.contextResolver.repository.upsert({
          recordId: record_id, version: newVersion,
          kind: kind || existing.kind,
          topicId: existing.topic_id,
          title: title ?? existing.title,
          summary: summary ?? existing.summary,
          content: content ?? JSON.parse(existing.content_json || '{}'),
          tags: tags ?? JSON.parse(existing.tags_json || '[]'),
          source: source ?? existing.source,
          priority: priority ?? existing.priority,
          mandatory: existing.mandatory,
          supersedesVersion: existing.version,
        });
        return `Updated record ${record_id} to version ${newVersion}.`;
      } catch (err) {
        return `Failed to update record: ${err.message}`;
      }
    },

    context_record_delete: async ({ record_id, version }) => {
      if (!ctx.contextResolver?.repository) return 'Context database is disabled or unconfigured.';
      try {
        const changes = await ctx.contextResolver.repository.remove(record_id, version);
        return changes ? `Deleted record ${record_id}${version ? ` v${version}` : ''} (${changes} row(s)).` : `Record ${record_id} not found.`;
      } catch (err) {
        return `Failed to delete record: ${err.message}`;
      }
    },
  };
}

module.exports = { CONTEXT_DEFS, makeExecutors };
