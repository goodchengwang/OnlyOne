#!/usr/bin/env node
require('../launcher.cjs').run(process.argv.slice(2), require('node:path').resolve(__dirname, '..')).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
