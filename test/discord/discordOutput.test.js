// Unit tests for src/discord/discordOutput.js's chunkMessage() — pure string
// logic, no Discord client needed.

const assert = require('assert');
const { chunkMessage } = require('../../src/discord/discordOutput');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`FAIL  ${name}: ${err.message}`); }
}

check('short text returns a single chunk unchanged', () => {
  const text = 'hello world';
  assert.deepStrictEqual(chunkMessage(text, 1900), [text]);
});

check('empty text returns no chunks', () => {
  assert.deepStrictEqual(chunkMessage('', 1900), []);
});

check('long plain text splits into chunks that never exceed the limit', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i} of some ordinary text`);
  const text = lines.join('\n');
  const chunks = chunkMessage(text, 100);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 100, `chunk exceeds limit: ${c.length}`);
});

check('long plain text (no fences) reassembles losslessly', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i} of some ordinary text`);
  const text = lines.join('\n');
  const chunks = chunkMessage(text, 100);
  assert.strictEqual(chunks.join('\n'), text);
});

check('a code fence spanning a chunk boundary is never left dangling open in any chunk', () => {
  const codeLines = ['```js', ...Array.from({ length: 30 }, (_, i) => `console.log(${i}); // some code line here`), '```'];
  const text = codeLines.join('\n');
  const chunks = chunkMessage(text, 60);
  assert.ok(chunks.length > 1, 'expected the fence to actually span multiple chunks for this test to be meaningful');
  for (const chunk of chunks) {
    const fenceLineCount = chunk.split('\n').filter((l) => l.trim().startsWith('```')).length;
    assert.strictEqual(fenceLineCount % 2, 0, `chunk has an unbalanced fence:\n${chunk}`);
    assert.ok(chunk.length <= 60 + '```js'.length + 4, `chunk grew unreasonably past the limit: ${chunk.length}`); // small allowance for the reopened fence line itself
  }
});

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall discordOutput tests passed');
process.exit(failures ? 1 : 0);
