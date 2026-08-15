// Discord contact list: the deterministic access gate. Anyone not on this
// list is ignored entirely (see src/discord/messageRouter.js). Only the
// owner (cfg.discord.ownerId, set by hand in config — never writable via
// Discord or any LLM tool) may add/remove/change contacts. This module is
// intentionally never registered as an agent tool: owner-only mutation is
// enforced here, in deterministic code, so a non-owner can't talk a model
// into granting themselves (or anyone else) access.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONTACTS_FILE = path.join(os.homedir(), '.voidcode', 'discord-contacts.json');

function load() {
  try {
    const raw = fs.readFileSync(CONTACTS_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data.contacts === 'object' && data.contacts !== null) return data;
  } catch { /* no file yet or corrupt — start fresh */ }
  return { contacts: {} };
}

function save(data) {
  fs.mkdirSync(path.dirname(CONTACTS_FILE), { recursive: true });
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function isOwner(discordUserId, cfg) {
  const ownerId = cfg?.discord?.ownerId;
  return !!ownerId && String(discordUserId) === String(ownerId);
}

// Returns 'owner', a stored tier string, or null (not a contact — ignore).
function getTier(discordUserId, cfg) {
  if (isOwner(discordUserId, cfg)) return 'owner';
  const data = load();
  const entry = data.contacts[String(discordUserId)];
  return entry ? entry.tier : null;
}

function requireOwner(requesterId, cfg) {
  if (!isOwner(requesterId, cfg)) {
    throw new Error('Only the owner can manage the contact list.');
  }
}

function addContact(requesterId, targetId, tier, cfg, note = '') {
  requireOwner(requesterId, cfg);
  if (!cfg.discord.tiers[tier]) throw new Error(`Unknown tier "${tier}". Known tiers: ${Object.keys(cfg.discord.tiers).join(', ')}`);
  if (isOwner(targetId, cfg)) throw new Error('The owner is always full-access — no need to add them as a contact.');
  const data = load();
  data.contacts[String(targetId)] = { tier, addedAt: new Date().toISOString(), note };
  save(data);
  return data.contacts[String(targetId)];
}

function setTier(requesterId, targetId, tier, cfg) {
  requireOwner(requesterId, cfg);
  if (!cfg.discord.tiers[tier]) throw new Error(`Unknown tier "${tier}". Known tiers: ${Object.keys(cfg.discord.tiers).join(', ')}`);
  const data = load();
  const entry = data.contacts[String(targetId)];
  if (!entry) throw new Error('That user is not on the contact list.');
  entry.tier = tier;
  save(data);
  return entry;
}

function removeContact(requesterId, targetId, cfg) {
  requireOwner(requesterId, cfg);
  const data = load();
  if (!data.contacts[String(targetId)]) throw new Error('That user is not on the contact list.');
  const removed = data.contacts[String(targetId)];
  delete data.contacts[String(targetId)];
  save(data);
  return removed;
}

function listContacts() {
  const data = load();
  return Object.entries(data.contacts).map(([id, entry]) => ({ id, ...entry }));
}

module.exports = { isOwner, getTier, addContact, setTier, removeContact, listContacts, CONTACTS_FILE };
