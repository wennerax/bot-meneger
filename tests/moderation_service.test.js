const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ModerationService = require('../app/services/moderation_service');

test('warnings are stored per chat and user', () => {
  const service = new ModerationService();

  assert.equal(service.addWarning(100, 7), 1);
  assert.equal(service.addWarning(100, 7), 2);
  assert.equal(service.getWarnings(100, 7), 2);
  assert.equal(service.getWarnings(200, 7), 0);
});

test('rules and filters are stored per chat and can be removed', () => {
  const service = new ModerationService();

  service.setRules(100, 'Будьте вежливы');
  service.addFilter(100, 'привет', 'Привет!');

  assert.equal(service.getRules(100), 'Будьте вежливы');
  assert.equal(service.findFilterResponse(100, 'ПРИВЕТ всем'), 'Привет!');
  assert.equal(service.findFilterResponse(200, 'привет'), null);
  assert.equal(service.removeFilter(100, 'SPAM'), false);
});

test('spam and link protection can be toggled per chat', () => {
  const service = new ModerationService();

  assert.equal(service.isSpamProtectionEnabled(100), false);
  assert.equal(service.isLinkProtectionEnabled(100), false);

  service.enableSpamProtection(100);
  service.enableLinkProtection(100);

  assert.equal(service.isSpamProtectionEnabled(100), true);
  assert.equal(service.isLinkProtectionEnabled(100), true);

  service.disableSpamProtection(100);
  service.disableLinkProtection(100);

  assert.equal(service.isSpamProtectionEnabled(100), false);
  assert.equal(service.isLinkProtectionEnabled(100), false);
});

test('flood protection can be toggled per chat', () => {
  const service = new ModerationService();

  assert.equal(service.isFloodProtectionEnabled(100), false);

  service.enableFloodProtection(100);
  assert.equal(service.isFloodProtectionEnabled(100), true);

  service.disableFloodProtection(100);
  assert.equal(service.isFloodProtectionEnabled(100), false);
});

test('moderation settings persist across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-meneger-'));
  const filePath = path.join(dir, 'bot.json');

  const first = new ModerationService(filePath);
  first.setRules(100, 'Будьте вежливы');
  first.setGreeting(100, 'Добро пожаловать');
  first.enableSpamProtection(100);
  first.addWarning(100, 7);
  first.addFilter(100, 'привет', 'Привет!');

  const second = new ModerationService(filePath);

  assert.equal(second.getRules(100), 'Будьте вежливы');
  assert.equal(second.getGreeting(100), 'Добро пожаловать');
  assert.equal(second.isSpamProtectionEnabled(100), true);
  assert.equal(second.getWarnings(100, 7), 1);
  assert.equal(second.findFilterResponse(100, 'ПРИВЕТ всем'), 'Привет!');
});
