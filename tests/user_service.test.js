const test = require('node:test');
const assert = require('node:assert/strict');
const UserService = require('../app/services/user_service');

test('register returns true only for new users', () => {
  const service = new UserService();

  assert.equal(service.register(42), true);
  assert.equal(service.register(42), false);
  assert.equal(service.count, 1);
});

test('users are counted across distinct ids', () => {
  const service = new UserService();

  service.register(1);
  service.register(2);

  assert.equal(service.count, 2);
});
