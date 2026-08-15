// Unit tests for src/discord/contacts.js. Redirects HOME/USERPROFILE to a
// throwaway temp dir BEFORE requiring the module under test, so this never
// touches the real ~/.voidcode/discord-contacts.json on the machine running it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'voidcode-contacts-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const contacts = require('../../src/discord/contacts');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`FAIL  ${name}: ${err.message}`); }
}

const cfg = {
  discord: {
    ownerId: 'owner-1',
    tiers: { owner: {}, trusted: {}, guest: {} },
  },
};

check('getTier returns owner for the configured ownerId', () => {
  assert.strictEqual(contacts.getTier('owner-1', cfg), 'owner');
});

check('getTier returns null for an unknown user', () => {
  assert.strictEqual(contacts.getTier('unknown-user', cfg), null);
});

check('non-owner cannot add a contact', () => {
  assert.throws(() => contacts.addContact('not-owner', 'friend-1', 'trusted', cfg), /Only the owner/);
});

check('owner can add, list, setTier, and remove a contact', () => {
  contacts.addContact('owner-1', 'friend-1', 'trusted', cfg);
  assert.strictEqual(contacts.getTier('friend-1', cfg), 'trusted');
  assert.deepStrictEqual(contacts.listContacts().map((c) => c.id), ['friend-1']);

  contacts.setTier('owner-1', 'friend-1', 'guest', cfg);
  assert.strictEqual(contacts.getTier('friend-1', cfg), 'guest');

  contacts.removeContact('owner-1', 'friend-1', cfg);
  assert.strictEqual(contacts.getTier('friend-1', cfg), null);
});

check('addContact rejects an unknown tier', () => {
  assert.throws(() => contacts.addContact('owner-1', 'friend-2', 'nonexistent-tier', cfg), /Unknown tier/);
});

check('cannot add the owner as a contact', () => {
  assert.throws(() => contacts.addContact('owner-1', 'owner-1', 'trusted', cfg), /always full-access/);
});

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall contacts tests passed');
process.exit(failures ? 1 : 0);
