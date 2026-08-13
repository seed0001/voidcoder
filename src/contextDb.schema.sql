-- VoidCode external context database schema, version 1.
-- This file defines structure only. No domain records are included.
CREATE TABLE IF NOT EXISTS context_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS context_records (
  record_id TEXT NOT NULL, version TEXT NOT NULL, kind TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_context_relationships_from ON context_relationships(from_record_id);
CREATE INDEX IF NOT EXISTS idx_context_relationships_to ON context_relationships(to_record_id);
CREATE TABLE IF NOT EXISTS context_record_versions (
  record_id TEXT NOT NULL, version TEXT NOT NULL, supersedes_version TEXT,
  created_at TEXT NOT NULL, PRIMARY KEY (record_id, version)
);
INSERT OR REPLACE INTO context_meta(key, value) VALUES ('schema_version', '1');
