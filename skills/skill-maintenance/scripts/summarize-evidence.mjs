import fs from 'node:fs';

const results = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!Array.isArray(results) || results.some(result => typeof result?.passed !== 'boolean')) {
  throw new Error('Expected an array of results with a boolean passed field');
}
console.log(JSON.stringify({ passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length }));
