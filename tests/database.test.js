const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('../app/services/database');

test('group owner is added to admin list and persists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-meneger-'));
  const db = new Database(path.join(dir, 'bot.json'));

  db.ensureGroup(100, 'Test group', 42);

  assert.equal(db.isAdmin(100, 42, []), true);
  assert.equal(db.isAdmin(200, 42, []), false);

  db.close();
});

test('message top is separate for each group and username resolves inside its group', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-meneger-'));
  const db = new Database(path.join(dir, 'bot.json'));

  db.ensureGroup(100, 'One');
  db.ensureGroup(200, 'Two');
  db.recordMessage(100, 1, 'Alice');
  db.recordMessage(100, 1, 'Alice');
  db.recordMessage(200, 2, 'Bob', 'bob');

  const top100 = db.topMessages(100, 10);
  const resolved = db.resolveUsername(100, '@bob');

  assert.equal(top100[0].displayName, 'Alice');
  assert.equal(top100[0].messageCount, 2);
  assert.equal(resolved, null);

  db.close();
});

test('owner becomes primary bot admin and can add auxiliary bot admins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-meneger-'));
  const db = new Database(path.join(dir, 'bot.json'));

  db.ensureGroup(300, 'Team', 77);
  db.addBotAdmin(300, 88);

  assert.equal(db.isPrimaryBotAdmin(300, 77), true);
  assert.equal(db.isBotAdmin(300, 77, []), true);
  assert.equal(db.isBotAdmin(300, 88, []), true);
  assert.deepEqual(db.getBotAdmins(300), [77, 88]);

  db.close();
});
