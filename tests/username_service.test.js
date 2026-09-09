const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUsername, getMentionText, resolveUsernameTarget } = require('../app/services/username_service');

test('normalizeUsername strips leading @ and lowercases the name', () => {
  assert.equal(normalizeUsername('@Alice'), 'alice');
  assert.equal(normalizeUsername('BOB'), 'bob');
});

test('getMentionText returns username mention for users with username', () => {
  assert.equal(getMentionText({ username: 'alice' }), '@alice');
  assert.equal(getMentionText({ first_name: 'Alice' }), 'Alice');
});

test('resolveUsernameTarget resolves a stored username to a target object', async () => {
  const ctx = {
    chat: { id: 100 },
    message: { entities: [], text: '@alice' },
    telegram: {
      getChatMember: async () => {
        throw new Error('should not be called');
      },
    },
  };

  const database = {
    resolveUsername: () => ({ userId: 42, displayName: 'Alice' }),
  };

  const result = await resolveUsernameTarget(ctx, '@alice', '/warn @username', database);

  assert.deepEqual(result, {
    target: { id: 42, first_name: 'Alice', username: 'alice' },
    remainingArgs: '',
  });
});

test('resolveUsernameTarget resolves a numeric user ID and preserves punishment arguments', async () => {
  const ctx = {
    chat: { id: 100 },
    message: { entities: [], text: '123456 2h спам' },
    telegram: {},
  };

  const result = await resolveUsernameTarget(ctx, '123456 2h спам', '/warn ID причина', {
    resolveUsername: () => null,
  });

  assert.deepEqual(result, {
    target: { id: 123456 },
    remainingArgs: '2h спам',
  });
});
