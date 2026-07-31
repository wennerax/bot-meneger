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

test('active punishments persist and can be removed manually', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-meneger-'));
  const db = new Database(path.join(dir, 'bot.json'));

  db.ensureGroup(400, 'Punish', 99);
  db.addActivePunishment(400, 101, 'mute', 'тест', 1700000000);

  assert.deepEqual(db.findActivePunishment(400, 101, 'mute'), {
    chatId: 400,
    userId: 101,
    action: 'mute',
    reason: 'тест',
    untilAt: 1700000000,
    createdAt: db.findActivePunishment(400, 101, 'mute').createdAt,
  });

  db.removeActivePunishment(400, 101, 'mute');
  assert.equal(db.findActivePunishment(400, 101, 'mute'), null);

  db.close();
});

test('profile descriptions and stats are stored per chat user', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-meneger-'));
  const db = new Database(path.join(dir, 'bot.json'));

  db.ensureGroup(500, 'Stats', 1);
  db.recordMessage(500, 2, 'Alice', 'alice');
  db.recordMessage(500, 2, 'Alice', 'alice');
  db.recordMessage(500, 3, 'Bob', 'bob');
  db.addPunishment(500, 2, 'warn', 'спам', null);
  db.setUserDescription(500, 2, 'Люблю музыку');

  const profile = db.getUserProfile(500, 2);

  assert.equal(profile.displayName, 'Alice');
  assert.equal(profile.username, '@alice');
  assert.equal(profile.messageCount, 2);
  assert.equal(profile.topPosition, 1);
  assert.equal(profile.description, 'Люблю музыку');
  assert.equal(profile.punishments.length, 1);
  assert.equal(profile.punishments[0].action, 'warn');

  db.close();
});

test('daily activity history is tracked per chat user', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-meneger-'));
  const db = new Database(path.join(dir, 'bot.json'));

  db.ensureGroup(600, 'Daily', 1);
  db.recordMessage(600, 2, 'Alice', 'alice');
  db.recordMessage(600, 2, 'Alice', 'alice');

  const history = db.getUserActivity(600, 2, 7);
  const today = history[history.length - 1];

  assert.ok(Array.isArray(history));
  assert.equal(history.length, 7);
  assert.ok(today);
  assert.equal(today.count, 2);

  db.close();
});
