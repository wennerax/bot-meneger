const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../app/config');

test('admin ids are parsed from comma separated values', () => {
  const settings = loadConfig({ BOT_TOKEN: 'token', ADMIN_IDS: '10, 20,10' }, { filePath: '.env' });

  assert.deepEqual(settings.adminIds, [10, 20]);
});

test('empty admin ids become an empty array', () => {
  const settings = loadConfig({ BOT_TOKEN: 'token', ADMIN_IDS: '' }, { filePath: '.env' });

  assert.deepEqual(settings.adminIds, []);
});
