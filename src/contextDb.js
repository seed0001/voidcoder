// SQL-backed execution context with topic collections.
// Uses sql.js (SQLite compiled to WebAssembly) — pure JavaScript, no native
// compilation, works identically in the Node CLI and the Electron desktop app.
//
// Topics are virtual "tables" the agent creates during research. Each topic
// groups related records (facts, rules, procedures, knowledge). The agent can
// create, list, delete topics and add/edit/delete records within them.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 3;
const DEFAULT_LIMIT = 40;
const DEFAULT_BUDGET_TOKENS = 6000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS context_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS context_topics (
  topic_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS context_records (
  record_id TEXT NOT NULL, version TEXT NOT NULL, kind TEXT NOT NULL,
  topic_id TEXT,
  title TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', content_json TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '{}', tags_json TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 0, mandatory INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, supersedes_version TEXT,
  PRIMARY KEY (record_id, version)
);
CREATE INDEX IF NOT EXISTS idx_context_records_active ON context_records(status, kind, priority);
CREATE INDEX IF NOT EXISTS idx_context_records_search ON context_records(title, summary, kind);
CREATE TABLE IF NOT EXISTS context_relationships (
  relationship_id TEXT PRIMARY KEY, from_record_id TEXT NOT NULL, from_version TEXT,
  to_record_id TEXT NOT NULL, to_version TEXT, relationship_type TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_relationships_from ON context_relationships(from_record_id, from_version);
CREATE INDEX IF NOT EXISTS idx_context_relationships_to ON context_relationships(to_record_id, to_version);
CREATE TABLE IF NOT EXISTS context_record_versions (
  record_id TEXT NOT NULL, version TEXT NOT NULL, supersedes_version TEXT,
  created_at TEXT NOT NULL, PRIMARY KEY (record_id, version)
);
CREATE TABLE IF NOT EXISTS container_refs (
  ref_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  is_dir INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL,
  last_indexed_at TEXT,
  content_hash TEXT,
  mtime_ms INTEGER,
  record_id TEXT,
  tier TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_container_refs_status ON container_refs(status);
INSERT OR REPLACE INTO context_meta(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');
`;

function now() { return new Date().toISOString(); }
function tokenEstimate(value) { return Math.ceil(String(value || '').length / 3.6); }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function hash(value) { return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex'); }
function required(value, name) { if (value === undefined || value === null || value === '') throw new Error(`${name} is required`); return value; }

class ContextDbError extends Error {
  constructor(code, message, cause) { super(message); this.name = 'ContextDbError'; this.code = code; this.cause = cause; }
}

// ---------------------------------------------------------------------------
// SqlJsDriver — pure-JS SQLite via WebAssembly. Loads the database file into
// memory, operates on it synchronously, and persists to disk after writes.
// Works in both Node and Electron (no native ABI issues).
// ---------------------------------------------------------------------------

class SqlJsDriver {
  constructor(file) {
    this.file = path.resolve(file);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = null;
    this._sqlModule = null;
  }

  async _load() {
    if (this.db) return;
    const initSqlJs = require('sql.js');
    this._sqlModule = await initSqlJs();
    if (fs.existsSync(this.file) && fs.statSync(this.file).size > 0) {
      this.db = new this._sqlModule.Database(fs.readFileSync(this.file));
    } else {
      this.db = new this._sqlModule.Database();
    }
    this.db.run('PRAGMA foreign_keys = ON');
  }

  _persist() {
    if (!this.db) return;
    const data = this.db.export();
    fs.writeFileSync(this.file, Buffer.from(data));
  }

  _get(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    let row = null;
    if (stmt.step()) row = stmt.getAsObject();
    stmt.free();
    return row;
  }

  _all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  _run(sql, params = []) {
    this.db.run(sql, params);
  }

  exec(sql) { this.db.run(sql); }
  close() { this.db?.close(); this.db = null; }

  async initialize() {
    await this._load();
    this.db.run(SCHEMA_SQL);
    // Migration: add columns missing in older v1 databases before creating
    // indexes that reference them.
    const columns = this._all("PRAGMA table_info(context_records)").map((r) => r.name);
    if (!columns.includes('topic_id')) this.db.run('ALTER TABLE context_records ADD COLUMN topic_id TEXT');
    if (!columns.includes('supersedes_version')) this.db.run('ALTER TABLE context_records ADD COLUMN supersedes_version TEXT');
    // Create topics table if it wasn't in the original v1 schema.
    this.db.run(`CREATE TABLE IF NOT EXISTS context_topics (
      topic_id TEXT PRIMARY KEY, title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    // Now safe to create indexes that reference migrated columns.
    this.db.run('CREATE INDEX IF NOT EXISTS idx_context_records_topic ON context_records(topic_id)');
    this._persist();
  }

  status() {
    const schema = this._get("SELECT value FROM context_meta WHERE key='schema_version'")?.value || null;
    const records = this._get('SELECT COUNT(*) AS count FROM context_records').count;
    const active = this._get("SELECT COUNT(*) AS count FROM context_records WHERE status='active'").count;
    const relationships = this._get('SELECT COUNT(*) AS count FROM context_relationships').count;
    const topics = this._get('SELECT COUNT(*) AS count FROM context_topics').count;
    return { file: this.file, schemaVersion: schema, records, activeRecords: active, relationships, topics };
  }

  // ---- topics ----

  createTopic({ title, description = '' }) {
    required(title, 'title');
    const topicId = crypto.randomUUID();
    const ts = now();
    this._run('INSERT INTO context_topics(topic_id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [topicId, title, description, ts, ts]);
    this._persist();
    return { topicId, title, description, createdAt: ts, updatedAt: ts };
  }

  listTopics() {
    const topics = this._all('SELECT * FROM context_topics ORDER BY updated_at DESC');
    return topics.map((t) => ({
      topicId: t.topic_id, title: t.title, description: t.description,
      createdAt: t.created_at, updatedAt: t.updated_at,
      recordCount: this._get('SELECT COUNT(*) AS count FROM context_records WHERE topic_id = ?', [t.topic_id]).count,
    }));
  }

  getTopic(topicId) {
    return this._get('SELECT * FROM context_topics WHERE topic_id = ?', [topicId]) || null;
  }

  deleteTopic(topicId) {
    required(topicId, 'topicId');
    this._run('DELETE FROM context_records WHERE topic_id = ?', [topicId]);
    this._run('DELETE FROM context_topics WHERE topic_id = ?', [topicId]);
    this._persist();
    return true;
  }

  // ---- records ----

  search({ text = '', kinds = [], topicId = null, limit = DEFAULT_LIMIT } = {}) {
    const n = Math.max(1, Math.min(200, Number(limit) || DEFAULT_LIMIT));
    const params = [];
    const clauses = ["status = 'active'"];
    if (text) {
      const stop = new Set(['a', 'an', 'and', 'for', 'find', 'get', 'the', 'to', 'of', 'on', 'in', 'with', 'about', 'please']);
      const terms = [...new Set(String(text).toLowerCase().replace(/[^a-z0-9_-]+/g, ' ').split(/\s+/).filter((t) => t.length > 1 && !stop.has(t)))].slice(0, 12);
      for (const term of terms) {
        const match = `%${term.replace(/[%_]/g, '')}%`;
        clauses.push('(LOWER(title) LIKE ? OR LOWER(summary) LIKE ? OR LOWER(content_json) LIKE ? OR LOWER(tags_json) LIKE ?)');
        params.push(match, match, match, match);
      }
    }
    if (Array.isArray(kinds) && kinds.length) {
      clauses.push(`kind IN (${kinds.map(() => '?').join(',')})`);
      params.push(...kinds);
    }
    if (topicId) {
      clauses.push('topic_id = ?');
      params.push(topicId);
    }
    const records = this._all(
      `SELECT * FROM context_records WHERE ${clauses.join(' AND ')} ORDER BY mandatory DESC, priority DESC, updated_at DESC LIMIT ${n}`,
      params
    );
    const relationships = this.relationshipsFor(records);
    return { records, relationships, retrievedAt: now() };
  }

  relationshipsFor(records) {
    if (!records.length) return [];
    const ids = [...new Set(records.map((r) => r.record_id))];
    const placeholders = ids.map(() => '?').join(',');
    return this._all(
      `SELECT * FROM context_relationships WHERE from_record_id IN (${placeholders}) OR to_record_id IN (${placeholders})`,
      [...ids, ...ids]
    );
  }

  list({ kind, status, topicId, limit = 200 } = {}) {
    const clauses = [];
    const params = [];
    if (kind) { clauses.push('kind = ?'); params.push(kind); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (topicId) { clauses.push('topic_id = ?'); params.push(topicId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this._all(
      `SELECT record_id, version, kind, topic_id, title, priority, mandatory, status, source, created_at, updated_at, supersedes_version FROM context_records ${where} ORDER BY updated_at DESC LIMIT ${Math.max(1, Math.min(1000, Number(limit) || 200))}`,
      params
    );
  }

  get(recordId, version = null) {
    if (version) return this._get('SELECT * FROM context_records WHERE record_id = ? AND version = ?', [recordId, version]) || null;
    return this._get('SELECT * FROM context_records WHERE record_id = ? ORDER BY updated_at DESC LIMIT 1', [recordId]) || null;
  }

  upsert(record) {
    const recordId = required(record.recordId || record.record_id, 'recordId');
    const version = String(required(record.version, 'version'));
    const kind = required(record.kind, 'kind');
    const content = record.content_json ?? JSON.stringify(record.content ?? {});
    if (typeof content !== 'string') throw new Error('content must be JSON-serializable');
    const timestamp = now();
    const existing = this.get(recordId, version);
    const row = {
      recordId, version, kind,
      topicId: record.topicId || record.topic_id || null,
      title: record.title || '', summary: record.summary || '', content,
      scope: JSON.stringify(record.scope || {}), tags: JSON.stringify(record.tags || []),
      priority: Number(record.priority) || 0, mandatory: record.mandatory ? 1 : 0,
      status: record.status || 'active', source: record.source || '',
      createdAt: existing?.created_at || timestamp, updatedAt: timestamp,
      supersedes: record.supersedesVersion || record.supersedes_version || null,
    };
    this._run(
      `INSERT INTO context_records(record_id,version,kind,topic_id,title,summary,content_json,scope_json,tags_json,priority,mandatory,status,source,created_at,updated_at,supersedes_version)
       VALUES(@recordId,@version,@kind,@topicId,@title,@summary,@content,@scope,@tags,@priority,@mandatory,@status,@source,@createdAt,@updatedAt,@supersedes)
       ON CONFLICT(record_id,version) DO UPDATE SET kind=excluded.kind,topic_id=excluded.topic_id,title=excluded.title,summary=excluded.summary,content_json=excluded.content_json,scope_json=excluded.scope_json,tags_json=excluded.tags_json,priority=excluded.priority,mandatory=excluded.mandatory,status=excluded.status,source=excluded.source,updated_at=excluded.updated_at,supersedes_version=excluded.supersedes_version`,
      [row.recordId, row.version, row.kind, row.topicId, row.title, row.summary, row.content, row.scope, row.tags, row.priority, row.mandatory, row.status, row.source, row.createdAt, row.updatedAt, row.supersedes]
    );
    this._run('INSERT OR REPLACE INTO context_record_versions(record_id,version,supersedes_version,created_at) VALUES(?,?,?,?)',
      [recordId, version, row.supersedes, timestamp]);
    this._persist();
    return this.get(recordId, version);
  }

  addRelationship(rel) {
    const relationshipId = rel.relationshipId || rel.relationship_id || crypto.randomUUID();
    this._run(
      `INSERT OR REPLACE INTO context_relationships(relationship_id,from_record_id,from_version,to_record_id,to_version,relationship_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)`,
      [relationshipId, required(rel.fromRecordId || rel.from_record_id, 'fromRecordId'), rel.fromVersion || rel.from_version || null,
       required(rel.toRecordId || rel.to_record_id, 'toRecordId'), rel.toVersion || rel.to_version || null,
       required(rel.relationshipType || rel.relationship_type, 'relationshipType'),
       JSON.stringify(rel.metadata || parseJson(rel.metadata_json, {})), now()]
    );
    this._persist();
    return this._get('SELECT * FROM context_relationships WHERE relationship_id = ?', [relationshipId]);
  }

  remove(recordId, version = null) {
    if (version) {
      this._run('DELETE FROM context_records WHERE record_id = ? AND version = ?', [recordId, version]);
    } else {
      this._run('DELETE FROM context_records WHERE record_id = ?', [recordId]);
    }
    this._persist();
    return this._get('SELECT changes() AS changes')?.changes ?? 0;
  }

  // ---- container refs (see src/containerIndexer.js) ----
  // One row per referenced file/folder in a container. Never holds file
  // content — content lives in context_records (record_id links the two).
  // This table exists purely to track identity/change-detection (path,
  // content_hash, mtime_ms) and indexing status, since nothing else in this
  // codebase tracks "have I seen this exact file content before".

  addContainerRef({ path: refPath, isDir = false }) {
    required(refPath, 'path');
    const existing = this._get('SELECT * FROM container_refs WHERE path = ?', [refPath]);
    if (existing) return existing;
    const refId = crypto.randomUUID();
    this._run(
      'INSERT INTO container_refs(ref_id, path, is_dir, added_at, status) VALUES (?, ?, ?, ?, ?)',
      [refId, refPath, isDir ? 1 : 0, now(), 'pending']
    );
    this._persist();
    return this._get('SELECT * FROM container_refs WHERE ref_id = ?', [refId]);
  }

  listContainerRefs({ status } = {}) {
    if (status) return this._all('SELECT * FROM container_refs WHERE status = ? ORDER BY added_at ASC', [status]);
    return this._all('SELECT * FROM container_refs ORDER BY added_at ASC');
  }

  getContainerRef(refId) {
    return this._get('SELECT * FROM container_refs WHERE ref_id = ?', [refId]) || null;
  }

  updateContainerRef(refId, patch = {}) {
    required(refId, 'refId');
    const fields = ['content_hash', 'mtime_ms', 'record_id', 'tier', 'status', 'last_error', 'last_indexed_at'];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (!(f in patch)) continue;
      sets.push(`${f} = ?`);
      params.push(patch[f]);
    }
    if (!sets.length) return this.getContainerRef(refId);
    params.push(refId);
    this._run(`UPDATE container_refs SET ${sets.join(', ')} WHERE ref_id = ?`, params);
    this._persist();
    return this.getContainerRef(refId);
  }

  removeContainerRef(refId) {
    required(refId, 'refId');
    const ref = this.getContainerRef(refId);
    if (ref?.record_id) this.remove(ref.record_id);
    this._run('DELETE FROM container_refs WHERE ref_id = ?', [refId]);
    this._persist();
    return true;
  }
}

// Backward-compat alias for existing imports/tests.
const BetterSqliteDriver = SqlJsDriver;

// ---------------------------------------------------------------------------
// Repository — async caching wrapper over the driver.
// ---------------------------------------------------------------------------

class ContextRepository {
  constructor(driver, { cacheTtlMs = 30000, cacheSize = 100 } = {}) {
    this.driver = driver;
    this.cacheTtlMs = cacheTtlMs;
    this.cacheSize = cacheSize;
    this.cache = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    if (!this.driver || typeof this.driver.exec !== 'function') throw new ContextDbError('unconfigured', 'Context database driver is not configured');
    try {
      if (this.driver.initialize) await this.driver.initialize();
      else await this.driver.exec(SCHEMA_SQL);
      this.initialized = true;
    } catch (err) {
      throw new ContextDbError('initialization', `Context database initialization failed: ${err.message}`, err);
    }
  }

  async search(request = {}) {
    const key = hash(request);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt >= Date.now()) return { ...cached.value, cached: true };
    try {
      await this.initialize();
      const result = await this.driver.search(request);
      const value = { records: result.records || [], relationships: result.relationships || [], retrievedAt: result.retrievedAt || now(), cached: false };
      this.cache.set(key, { value, expiresAt: Date.now() + this.cacheTtlMs });
      while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
      return value;
    } catch (err) {
      if (err instanceof ContextDbError) throw err;
      throw new ContextDbError('query', `Context database query failed: ${err.message}`, err);
    }
  }

  invalidate() { this.cache.clear(); }

  async status() { await this.initialize(); return this.driver.status(); }
  async list(options) { await this.initialize(); return this.driver.list(options); }
  async get(recordId, version) { await this.initialize(); return this.driver.get(recordId, version); }
  async upsert(record) { await this.initialize(); const result = this.driver.upsert(record); this.invalidate(); return result; }
  async addRelationship(rel) { await this.initialize(); const result = this.driver.addRelationship(rel); this.invalidate(); return result; }
  async remove(recordId, version) { await this.initialize(); const result = this.driver.remove(recordId, version); this.invalidate(); return result; }
  async createTopic(opts) { await this.initialize(); const result = this.driver.createTopic(opts); this.invalidate(); return result; }
  async listTopics() { await this.initialize(); return this.driver.listTopics(); }
  async deleteTopic(topicId) { await this.initialize(); const result = this.driver.deleteTopic(topicId); this.invalidate(); return result; }

  async addContainerRef(ref) { await this.initialize(); return this.driver.addContainerRef(ref); }
  async listContainerRefs(options) { await this.initialize(); return this.driver.listContainerRefs(options); }
  async getContainerRef(refId) { await this.initialize(); return this.driver.getContainerRef(refId); }
  async updateContainerRef(refId, patch) { await this.initialize(); const result = this.driver.updateContainerRef(refId, patch); this.invalidate(); return result; }
  async removeContainerRef(refId) { await this.initialize(); const result = this.driver.removeContainerRef(refId); this.invalidate(); return result; }

  close() { this.driver?.close?.(); }
}

// ---------------------------------------------------------------------------
// Resolver — assembles the context package injected into the system prompt.
// ---------------------------------------------------------------------------

class ContextResolver {
  constructor(repository, { budgetTokens = DEFAULT_BUDGET_TOKENS, maxRecords = DEFAULT_LIMIT } = {}) {
    this.repository = repository;
    this.budgetTokens = budgetTokens;
    this.maxRecords = maxRecords;
  }

  async resolve({ task = '', agentKind = 'main', scope = {}, kinds = [], topicId = null, maxRecords, budgetTokens } = {}) {
    const started = Date.now();
    const trace = { traceId: crypto.randomUUID(), agentKind, task: String(task), retrievedAt: now(), recordsRetrieved: [], recordsInjected: [], recordsOmitted: [], relationships: [], estimatedTokens: 0, budgetTokens: budgetTokens || this.budgetTokens, status: 'disabled', errors: [], lookupDurationMs: 0, assemblyDurationMs: 0 };
    if (!this.repository) return { ...this.emptyPackage(trace), trace };
    let result;
    try { result = await this.repository.search({ text: task, scope, kinds, topicId, limit: maxRecords || this.maxRecords }); }
    catch (err) {
      trace.status = 'unavailable';
      trace.errors.push({ code: err.code || 'query', message: err.message });
      trace.lookupDurationMs = Date.now() - started;
      return { ...this.emptyPackage(trace), trace };
    }
    trace.lookupDurationMs = Date.now() - started;
    const records = [];
    for (const raw of result.records) {
      const normalized = this.normalizeRecord(raw);
      if (normalized) records.push(normalized);
      else trace.errors.push({ code: 'malformed_record', message: `Skipped malformed context record ${raw?.record_id || '(unknown)'}` });
    }
    trace.recordsRetrieved = records.map(this.traceRecord);
    const budget = Math.max(1, Number(budgetTokens || this.budgetTokens));
    const selected = [];
    let used = 0;
    for (const record of [...records.filter((r) => r.mandatory), ...records.filter((r) => !r.mandatory)]) {
      const cost = tokenEstimate(recordForPrompt(record));
      if (used + cost <= budget) { selected.push(record); used += cost; }
      else trace.recordsOmitted.push({ ...this.traceRecord(record), reason: record.mandatory ? 'mandatory_context_overflow' : 'context_budget' });
    }
    const mandatoryOverflow = records.filter((r) => r.mandatory).some((r) => !selected.includes(r));
    if (mandatoryOverflow) { trace.status = 'incomplete_mandatory'; trace.errors.push({ code: 'mandatory_context_overflow', message: 'Mandatory database context cannot fit within the configured budget.' }); }
    else trace.status = 'ready';
    trace.recordsInjected = selected.map((r) => ({ ...this.traceRecord(r), estimatedTokens: tokenEstimate(recordForPrompt(r)) }));
    trace.relationships = (result.relationships || []).filter((rel) => selected.some((r) => r.recordId === rel.from_record_id || r.recordId === rel.to_record_id));
    trace.estimatedTokens = used;
    trace.assemblyDurationMs = Date.now() - started - trace.lookupDurationMs;
    const categories = ['instruction', 'rule', 'procedure', 'action', 'validation', 'fallback'];
    return {
      schemaVersion: 1, status: trace.status, mandatoryContextComplete: !mandatoryOverflow,
      budgetTokens: budget, estimatedTokens: used,
      instructions: selected.filter((r) => r.kind === 'instruction').map(recordForPrompt),
      rules: selected.filter((r) => r.kind === 'rule').map(recordForPrompt),
      procedures: selected.filter((r) => r.kind === 'procedure').map(recordForPrompt),
      actions: selected.filter((r) => r.kind === 'action').map(recordForPrompt),
      validations: selected.filter((r) => r.kind === 'validation').map(recordForPrompt),
      fallbacks: selected.filter((r) => r.kind === 'fallback').map(recordForPrompt),
      knowledge: selected.filter((r) => !categories.includes(r.kind)).map(recordForPrompt),
      records: selected.map(recordForPrompt), relationships: trace.relationships,
      provenance: trace.recordsInjected, trace,
    };
  }

  normalizeRecord(r) {
    const recordId = r?.record_id || r?.recordId;
    const rawContent = r?.content_json ?? r?.content;
    if (!recordId || !r?.kind || rawContent === undefined || rawContent === null) return null;
    let content = rawContent;
    if (typeof rawContent === 'string' && (r.content_json !== undefined || /^[\[{]/.test(rawContent.trim()))) {
      try { content = JSON.parse(rawContent); } catch { return null; }
    }
    return {
      recordId, version: String(r.version || '1'), kind: r.kind,
      topicId: r.topic_id || r.topicId || null,
      title: r.title || '', summary: r.summary || '', content,
      priority: Number(r.priority) || 0, mandatory: !!(r.mandatory === 1 || r.mandatory === true),
      source: r.source || '', scope: parseJson(r.scope_json ?? r.scope, {}), tags: parseJson(r.tags_json ?? r.tags, []),
    };
  }

  traceRecord(r) { return { recordId: r.recordId, version: r.version, kind: r.kind, mandatory: r.mandatory, source: r.source }; }
  emptyPackage(trace) { return { schemaVersion: 1, status: trace.status, mandatoryContextComplete: true, budgetTokens: trace.budgetTokens, estimatedTokens: 0, instructions: [], rules: [], procedures: [], actions: [], validations: [], fallbacks: [], knowledge: [], records: [], relationships: [], provenance: [] }; }
}

function recordForPrompt(r) {
  return { id: r.recordId, version: r.version, kind: r.kind, topicId: r.topicId, title: r.title, summary: r.summary, content: r.content, priority: r.priority, mandatory: r.mandatory, source: r.source, tags: r.tags };
}

function createContextService(cfg = {}, cwd = process.cwd()) {
  const c = cfg.contextDb || {};
  if (c.enabled === false) return { repository: null, resolver: null, enabled: false };
  let driver;
  try {
    driver = c.driver || new SqlJsDriver(path.resolve(cwd, c.path || '.voidcode/context.sqlite'));
  } catch (err) {
    return { repository: null, resolver: null, enabled: false, error: { code: err.code || 'driver', message: err.message } };
  }
  const repository = new ContextRepository(driver, { cacheTtlMs: c.cacheTtlMs || 30000, cacheSize: c.cacheSize || 100 });
  return { repository, resolver: new ContextResolver(repository, { budgetTokens: c.budgetTokens || DEFAULT_BUDGET_TOKENS, maxRecords: c.maxRecords || DEFAULT_LIMIT }), enabled: true };
}

module.exports = { SCHEMA_VERSION, SCHEMA_SQL, ContextDbError, ContextRepository, ContextResolver, SqlJsDriver, BetterSqliteDriver, createContextService, tokenEstimate, recordForPrompt };
