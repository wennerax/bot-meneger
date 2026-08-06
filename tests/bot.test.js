const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePunishmentDetails, buildPunishmentNotification, buildModerationAlertMessage, buildFunReply, parsePageNumber, buildPunishmentListMessage, buildBotAdminListMessage, detectForbiddenWord, isLinkMessage, isAllowedLinkUrl } = require('../app/bot');
const { buildAiRequestPayload } = require('../app/ai');

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

test('buildModerationAlertMessage includes duration and reason', () => {
  const message = buildModerationAlertMessage('@alice', 24, 'Спам');

  assert.equal(message, '⚠️ Пользователь @alice замучен на 1д по причине: Спам.');
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
  const message = buildBotAdminListMessage('@alice', ['@bob', '@carol']);

  assert.match(message, /Главный админ:\s*\n1\. @alice/);
  assert.match(message, /1\. @bob/);
  assert.match(message, /2\. @carol/);
});

test('detectForbiddenWord catches drugs and self-harm variants', () => {
  assert.equal(detectForbiddenWord('сегодня курю weed'), 'weed');
  assert.equal(detectForbiddenWord('наркоыыыыыы'), 'нарко');
  assert.equal(detectForbiddenWord('наркофирма'), 'нарко');
  assert.equal(detectForbiddenWord('метсоленый'), 'мет');
  assert.ok(['self-harm', 'selfharm'].includes(detectForbiddenWord('хочу self-harm')));
  assert.equal(detectForbiddenWord('доброе утро друзья'), null);
});

test('allowed links bypass link protection while suspicious ones trigger it', () => {
  assert.equal(isAllowedLinkUrl('https://t.me/testgroup'), false);
  assert.equal(isAllowedLinkUrl('https://example.com/shop'), false);
  assert.equal(isLinkMessage('https://t.me/testgroup'), true);
  assert.equal(isLinkMessage('https://example.com/shop'), true);
  assert.equal(isLinkMessage('https://t.me/testgroup', (link) => link.includes('t.me')), false);
  assert.equal(isLinkMessage('https://example.com/shop', (link) => link.includes('t.me')), true);
});

test('buildAiRequestPayload builds an OpenAI-compatible request body', async () => {
  const payload = await buildAiRequestPayload('привет', 'gpt-4o-mini');

  assert.equal(payload.model, 'gpt-4o-mini');
  assert.equal(payload.messages[1].role, 'user');
  assert.match(payload.messages[1].content, /привет/);
});
