'use strict';
// Runs every JavaScript test file in turn and fails if any of them fail.
const { spawnSync } = require('child_process');
const path = require('path');

const files = [
  'security.test.cjs',
  'allocation.test.cjs',
  'moves-rules.test.cjs',
  'pots.test.cjs',
  'card-code.test.cjs',
  'ui.test.cjs'
];

let failed = 0;
for (const f of files) {
  console.log('\n=== ' + f + ' ===');
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.log('>>> ' + f + ' FAILED'); }
}
console.log('\n' + (failed ? failed + ' test file(s) failed' : 'All JavaScript test files passed'));
process.exit(failed ? 1 : 0);
