#!/usr/bin/env node
require('../src/index.js').main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
