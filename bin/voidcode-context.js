#!/usr/bin/env node
const path = require('path');
const config = require('../src/config');
const { createContextService } = require('../src/contextDb');

function usage() {
  console.log(`voidcode-context — manage the project's SQL execution context\n\nCommands:\n  init                         create/apply the empty context database schema\n  status                       show database and record counts\n  list [--kind K] [--status S] list records\n  get <recordId> [version]     print one record as JSON\n  upsert <json|@file>          create/update one versioned record\n  relate <json|@file>          create/update a relationship\n  remove <recordId> [version]  remove a record/version\n\nNo domain content is created automatically.\n`);
}
function parseValue(value) {
  if (value?.startsWith('@')) return require('fs').readFileSync(path.resolve(value.slice(1)), 'utf8').replace(/^\uFEFF/, '');
  return value;
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') return usage();
  const cwd = process.cwd();
  const cfg = config.load(cwd);
  const service = createContextService({ ...cfg, contextDb: { ...(cfg.contextDb || {}), enabled: true } }, cwd);
  const repo = service.repository;
  try {
    if (command === 'init') { await repo.initialize(); console.log(JSON.stringify(await repo.status(), null, 2)); return; }
    if (command === 'status') { console.log(JSON.stringify(await repo.status(), null, 2)); return; }
    if (command === 'list') {
      const kindIndex = args.indexOf('--kind'); const statusIndex = args.indexOf('--status');
      console.log(JSON.stringify(await repo.list({ kind: kindIndex >= 0 ? args[kindIndex + 1] : undefined, status: statusIndex >= 0 ? args[statusIndex + 1] : undefined }), null, 2)); return;
    }
    if (command === 'get') { if (!args[0]) throw new Error('recordId is required'); console.log(JSON.stringify(await repo.get(args[0], args[1] || null), null, 2)); return; }
    if (command === 'upsert') { if (!args[0]) throw new Error('JSON object or @file is required'); const record = JSON.parse(parseValue(args[0])); console.log(JSON.stringify(await repo.upsert(record), null, 2)); return; }
    if (command === 'relate') { if (!args[0]) throw new Error('JSON object or @file is required'); const relationship = JSON.parse(parseValue(args[0])); console.log(JSON.stringify(await repo.addRelationship(relationship), null, 2)); return; }
    if (command === 'remove') { if (!args[0]) throw new Error('recordId is required'); console.log(JSON.stringify({ removed: await repo.remove(args[0], args[1] || null) }, null, 2)); return; }
    usage(); process.exitCode = 1;
  } finally { repo.close(); }
}
main().catch(err => { console.error(`context error: ${err.message}`); process.exitCode = 1; });
