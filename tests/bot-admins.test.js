const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../app/services/database');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('owner is recognized as primary bot admin and can add auxiliary admin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-meneger-'));
  const db = new Database(path.join(dir, 'bot.json'));

  db.ensureGroup(500, 'Demo', 10);
  db.addBotAdmin(500, 20);

  assert.equal(db.isPrimaryBotAdmin(500, 10), true);
  assert.equal(db.isBotAdmin(500, 10), true);
  assert.equal(db.isBotAdmin(500, 20), true);
  assert.deepEqual(db.getBotAdmins(500), [10, 20]);

  db.close();
});

test('leader cannot manage other bot admins, but owner still can', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-meneger-'));
  const db = new Database(path.join(dir, 'bot.json'));

  db.ensureGroup(600, 'Hierarchy', 10);
  db.addBotAdmin(600, 20, 2);
  db.addBotAdmin(600, 30, 3);

  assert.equal(db.canManageBotAdmin(600, 20, 30), false);
  assert.equal(db.canManageBotAdmin(600, 20, 20), false);
  assert.equal(db.canManageBotAdmin(600, 10, 20), true);
  assert.equal(db.canManageBotAdmin(600, 30, 20), false);

  db.close();
});

test('higher-priority admins cannot be punished by lower-priority admins and lower-rank admins can be managed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-meneger-'));
  const db = new Database(path.join(dir, 'bot.json'));

  db.ensureGroup(700, 'Permissions', 10);
  db.addBotAdmin(700, 20, 2);
  db.addBotAdmin(700, 30, 3);
  db.addBotAdmin(700, 40, 4);

  assert.equal(db.canPunishBotAdmin(700, 20, 30), true);
  assert.equal(db.canPunishBotAdmin(700, 30, 20), false);
  assert.equal(db.canPunishBotAdmin(700, 40, 30), false);
  assert.equal(db.canManageBotAdmin(700, 30, 40), true);
  assert.equal(db.canManageBotAdmin(700, 20, 40), false);
  assert.equal(db.canManageBotAdmin(700, 10, 20), true);
  assert.equal(db.canManageBotAdmin(700, 20, 20), false);

  db.close();
});
