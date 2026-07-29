const test = require('node:test');
const assert = require('node:assert/strict');
const ModerationService = require('../app/services/moderation_service');
const { getFunnyDescription } = require('../app/services/moderation_service');

test('greeting is stored per chat and can be updated', () => {
  const service = new ModerationService();

  service.setGreeting(100, 'Добро пожаловать в наш чат!');

  assert.equal(service.getGreeting(100), 'Добро пожаловать в наш чат!');
  assert.equal(service.getGreeting(200), 'Добро пожаловать в чат! Ознакомьтесь с правилами через /rules.');
});

test('getFunnyDescription returns a string', () => {
  const description = getFunnyDescription();

  assert.equal(typeof description, 'string');
  assert.ok(description.length > 0);
});
