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

test('group title is updated when Telegram sends a new title', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-meneger-'));
  const db = new Database(path.join(dir, 'bot.json'));

  db.ensureGroup(101, 'Old title', 42);
  db.ensureGroup(101, 'New title');

  assert.equal(db.data.groups[101].title, 'New title');
  assert.equal(db.data.groups[101].ownerId, 42);

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

test('bot admin warnings remove an auxiliary admin at the configured limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-meneger-'));
  const db = new Database(path.join(dir, 'bot.json'));

  db.ensureGroup(301, 'Warnings', 10);
  db.addBotAdmin(301, 20, 3);
  assert.deepEqual(db.addBotAdminWarning(301, 20), { count: 1, removed: false, demoted: false, previousLevel: 3, currentLevel: 3 });
  assert.deepEqual(db.addBotAdminWarning(301, 20), { count: 2, removed: false, demoted: false, previousLevel: 3, currentLevel: 3 });
  assert.deepEqual(db.addBotAdminWarning(301, 20), { count: 3, removed: true, demoted: false, previousLevel: 3, currentLevel: null });
  assert.equal(db.isBotAdmin(301, 20), false);
  assert.equal(db.getBotAdminWarnings(301, 20), 3);

  db.close();
});

test('bot admin warning reset preserves the primary admin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-meneger-'));
  const db = new Database(path.join(dir, 'bot.json'));

  db.ensureGroup(302, 'Owner warnings', 10);
  assert.deepEqual(db.addBotAdminWarning(302, 10), { count: 0, removed: false, demoted: false, previousLevel: 1, currentLevel: 1 });
  assert.equal(db.isBotAdmin(302, 10), true);

  db.close();
});

test('bot admin warnings can demote at a configurable limit or leave rank unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-meneger-'));
  const db = new Database(path.join(dir, 'bot.json'));

  db.ensureGroup(303, 'Moderator warning settings', 10);
  db.addBotAdmin(303, 20, 3);
  db.addBotAdminWarning(303, 20, { limit: 2, punishmentMode: 'demote' });
  const demoted = db.addBotAdminWarning(303, 20, { limit: 2, punishmentMode: 'demote' });
  assert.equal(demoted.demoted, true);
  assert.equal(demoted.previousLevel, 3);
  assert.equal(demoted.currentLevel, 4);
  assert.equal(db.getBotAdminWarnings(303, 20), 2);
  const laterWarning = db.addBotAdminWarning(303, 20, { limit: 2, punishmentMode: 'demote' });
  assert.equal(laterWarning.demoted, false);
  assert.equal(laterWarning.currentLevel, 4);

  db.addBotAdmin(303, 30, 4);
  db.addBotAdminWarning(303, 30, { limit: 2, punishmentMode: 'off' });
  db.addBotAdminWarning(303, 30, { limit: 2, punishmentMode: 'off' });
  assert.equal(db.isBotAdmin(303, 30), true);
  assert.equal(db.getBotAdminLevel(303, 30), 4);
  assert.equal(db.decrementBotAdminWarning(303, 30), 1);

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

test('same active punishment is not duplicated in history and profile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-meneger-'));
  const db = new Database(path.join(dir, 'bot.json'));

  db.ensureGroup(505, 'Duplicate punishments', 1);
  db.addPunishment(505, 2, 'mute', 'тест', 1700000000);
  db.addActivePunishment(505, 2, 'mute', 'тест', 1700000000);

  const profile = db.getUserProfile(505, 2);

  assert.equal(profile.punishments.length, 1);
  assert.equal(db.data.punishments.length, 1);
  assert.equal(db.data.activePunishments.length, 1);

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

test('user streak is calculated from consecutive days and exposed in profile and top list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-meneger-'));
  const db = new Database(path.join(dir, 'bot.json'));

  db.ensureGroup(700, 'Streaks', 1);
  const today = new Date();
  const dayKeys = Array.from({ length: 3 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (2 - index));
    return date.toISOString().slice(0, 10);
  });

  db.data.dailyActivity[700] = {
    2: [
      { day: dayKeys[0], count: 1 },
      { day: dayKeys[1], count: 2 },
      { day: dayKeys[2], count: 3 },
      { day: '2020-01-01', count: 1 },
    ],
  };
  db.data.messageCounts[700] = {
    2: { displayName: 'Alice', messageCount: 42 },
  };

  const profile = db.getUserProfile(700, 2);
  const top = db.topMessages(700, 10);

  assert.equal(profile.streak, 3);
  assert.equal(profile.streakBadge.includes('3'), true);
  assert.equal(top[0].streak, 3);

  db.close();
});

test('user streak resets to zero after a missed day without new chat activity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-meneger-'));
  const db = new Database(path.join(dir, 'bot.json'));

  db.ensureGroup(710, 'Missed Day', 1);
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

  db.data.dailyActivity[710] = {
    2: [{ day: twoDaysAgo.toISOString().slice(0, 10), count: 1 }],
  };

  const profile = db.getUserProfile(710, 2);
  assert.equal(profile.streak, 0);

  db.close();
});

test('user streak remains visible when the latest activity was yesterday', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-meneger-'));
  const db = new Database(path.join(dir, 'bot.json'));

  db.ensureGroup(711, 'Yesterday streak', 1);
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const twoDaysAgo = new Date(yesterday);
  twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 1);

  db.data.dailyActivity[711] = {
    2: [
      { day: twoDaysAgo.toISOString().slice(0, 10), count: 1 },
      { day: yesterday.toISOString().slice(0, 10), count: 1 },
    ],
  };

  assert.equal(db.getUserProfile(711, 2).streak, 2);

  db.close();
});

test('punishment history can be cleared for a specific user', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-meneger-'));
  const db = new Database(path.join(dir, 'bot.json'));

  db.ensureGroup(800, 'History', 1);
  db.addPunishment(800, 2, 'warn', 'спам', null);
  db.addPunishment(800, 2, 'mute', 'шум', 1800000000);
  db.addActivePunishment(800, 2, 'mute', 'шум', 1800000000);

  db.clearUserPunishmentHistory(800, 2);

  const profile = db.getUserProfile(800, 2);
  assert.deepEqual(profile.punishments, []);

  db.close();
});
