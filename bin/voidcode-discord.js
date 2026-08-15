#!/usr/bin/env node
require('../src/discord/daemon.js').main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
