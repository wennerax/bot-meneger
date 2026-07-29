const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePunishmentDetails, buildPunishmentNotification, buildFunReply, parsePageNumber, buildPunishmentListMessage, buildBotAdminListMessage, buildLocalAiReply, buildAiRequestPayload } = require('../app/bot');

test('parsePunishmentDetails extracts duration and reason', () => {
  const result = parsePunishmentDetails('1d реклама', false);

  assert.deepEqual(result, { durationHours: 24, reason: 'реклама' });
});

test('parsePunishmentDetails returns default reason when none provided', () => {
  const result = parsePunishmentDetails('2h', false);

  assert.deepEqual(result, { durationHours: 2, reason: 'Без причины' });
});

test('buildPunishmentNotification includes group, reason and duration', () => {
  const message = buildPunishmentNotification('mute', 'Test Group', 'спам', 2);

  assert.equal(message, 'Вы были ограничен(а) в чате "Test Group". Причина: спам. Срок: 2ч.');
});

test('buildFunReply returns a valid coin result', () => {
  const result = buildFunReply('coin');

  assert.ok(result === 'Орёл' || result === 'Решка');
});

test('buildFunReply returns a valid dice result', () => {
  const result = buildFunReply('dice');

  assert.ok(/^[1-6]$/.test(result));
});

test('parsePageNumber defaults to page 1 and accepts explicit pages', () => {
  assert.equal(parsePageNumber(''), 1);
  assert.equal(parsePageNumber('2'), 2);
  assert.equal(parsePageNumber('abc'), 1);
});

test('buildPunishmentListMessage paginates active bans and mutes', () => {
  const punishments = Array.from({ length: 12 }, (_, index) => ({
    userId: index + 1,
    reason: `reason-${index + 1}`,
    untilAt: null,
  }));

  const pageOne = buildPunishmentListMessage('ban', punishments, 1, 5);
  const pageTwo = buildPunishmentListMessage('mute', punishments, 2, 5);

  assert.match(pageOne, /Баны \(страница 1\/3\)/);
  assert.match(pageOne, /1\. User 1/);
  assert.match(pageTwo, /Муты \(страница 2\/3\)/);
  assert.match(pageTwo, /6\. User 6/);
});

test('buildBotAdminListMessage separates primary and auxiliary admins', () => {
  const message = buildBotAdminListMessage(1001, ['1002', '1003']);

  assert.match(message, /Главный администратор/);
  assert.match(message, /Вспомогательные администраторы/);
  assert.match(message, /1002/);
});

test('buildLocalAiReply returns a helpful offline answer', () => {
  const reply = buildLocalAiReply('привет');

  assert.match(reply, /привет|локальный помощник/i);
});

test('buildAiRequestPayload builds an OpenAI-compatible request body', () => {
  const payload = buildAiRequestPayload('привет', 'gpt-4o-mini');

  assert.equal(payload.model, 'gpt-4o-mini');
  assert.equal(payload.messages[1].role, 'user');
  assert.match(payload.messages[1].content, /привет/);
});
