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
