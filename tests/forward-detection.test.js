const test = require('node:test');
const assert = require('node:assert/strict');
const { detectForwardedMessageCategory } = require('../app/bot');

test('detectForwardedMessageCategory returns null for non-forwarded messages', () => {
  const message = {
    message_id: 1,
    date: Date.now(),
    text: 'Hello',
  };

  assert.equal(detectForwardedMessageCategory(message), null);
});

test('detectForwardedMessageCategory returns "channels" for messages from channels', () => {
  const message = {
    message_id: 1,
    date: Date.now(),
    text: 'Hello',
    forward_from_chat: {
      id: -1001234567890,
      type: 'channel',
      title: 'Test Channel',
    },
  };

  assert.equal(detectForwardedMessageCategory(message), 'channels');
});

test('detectForwardedMessageCategory returns "groups" for messages from groups', () => {
  const message = {
    message_id: 1,
    date: Date.now(),
    text: 'Hello',
    forward_from_chat: {
      id: -1001234567890,
      type: 'group',
      title: 'Test Group',
    },
  };

  assert.equal(detectForwardedMessageCategory(message), 'groups');
});

test('detectForwardedMessageCategory returns "groups" for messages from supergroups', () => {
  const message = {
    message_id: 1,
    date: Date.now(),
    text: 'Hello',
    forward_from_chat: {
      id: -1001234567890,
      type: 'supergroup',
      title: 'Test Group',
    },
  };

  assert.equal(detectForwardedMessageCategory(message), 'groups');
});

test('detectForwardedMessageCategory returns "bots" for messages from bots', () => {
  const message = {
    message_id: 1,
    date: Date.now(),
    text: 'Hello',
    forward_from: {
      id: 123456789,
      is_bot: true,
      first_name: 'Bot',
    },
  };

  assert.equal(detectForwardedMessageCategory(message), 'bots');
});

test('detectForwardedMessageCategory returns "users" for messages from regular users', () => {
  const message = {
    message_id: 1,
    date: Date.now(),
    text: 'Hello',
    forward_from: {
      id: 123456789,
      is_bot: false,
      first_name: 'User',
    },
  };

  assert.equal(detectForwardedMessageCategory(message), 'users');
});

test('detectForwardedMessageCategory defaults to "users" when is_bot is undefined', () => {
  const message = {
    message_id: 1,
    date: Date.now(),
    text: 'Hello',
    forward_from: {
      id: 123456789,
      first_name: 'User',
    },
  };

  assert.equal(detectForwardedMessageCategory(message), 'users');
});

test('detectForwardedMessageCategory returns null for invalid input', () => {
  assert.equal(detectForwardedMessageCategory(null), null);
  assert.equal(detectForwardedMessageCategory(undefined), null);
  assert.equal(detectForwardedMessageCategory({}), null);
});
