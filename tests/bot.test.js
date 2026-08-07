const test = require('node:test');
const assert = require('node:assert/strict');
const { createBot, parsePunishmentDetails, buildPunishmentNotification, buildModerationAlertMessage, buildFunReply, parsePageNumber, buildPunishmentListMessage, buildBotAdminListMessage, detectForbiddenWord, isLinkMessage, isAllowedLinkUrl, buildSettingsMainKeyboard, parseSettingsAction, isGroupMemberWithProfileChangePermission, getGroupDisplayName, buildCaptchaChallenge, shouldStartCaptchaForChat } = require('../app/bot');
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

test('buildSettingsMainKeyboard returns a grouped layout with section buttons', () => {
  const keyboard = buildSettingsMainKeyboard(42);

  assert.ok(Array.isArray(keyboard));
  assert.equal(keyboard.length, 3);
  assert.deepEqual(keyboard[0].map((button) => button.text), ['Капча', 'Ссылки']);
  assert.deepEqual(keyboard[1].map((button) => button.text), ['Анти(СФС)', 'Правила']);
  assert.deepEqual(keyboard[2].map((button) => button.text), ['Сообщение']);
  assert.equal(keyboard[0][0].callback_data, 'settings:section:captcha:42');
  assert.equal(keyboard[0][1].callback_data, 'settings:section:links:42');
  assert.equal(keyboard[1][0].callback_data, 'settings:section:anti:42');
  assert.equal(keyboard[1][1].callback_data, 'settings:section:rules:42');
  assert.equal(keyboard[2][0].callback_data, 'settings:open_menu:42');
});

test('buildCaptchaChallenge returns a math-mode prompt with a deterministic answer', () => {
  const challenge = buildCaptchaChallenge('math', 'Алиса');

  assert.equal(challenge.prompt, 'Капча для пользователя Алиса. Реши пример: 2 + 3');
  assert.deepEqual(challenge.options, ['5', '4', '6', '7']);
  assert.equal(challenge.correctOption, '5');
});

test('shouldStartCaptchaForChat respects the configured enable flag', () => {
  assert.equal(shouldStartCaptchaForChat(42, { isCaptchaEnabled: () => false }), false);
  assert.equal(shouldStartCaptchaForChat(42, { isCaptchaEnabled: () => true }), true);
});

test('buildCaptchaChallenge uses a valid option set for word mode', () => {
  const challenge = buildCaptchaChallenge('word', 'Алиса');

  assert.match(challenge.prompt, /Алиса/);
  assert.equal(challenge.correctOption, 'кот');
  assert.equal(challenge.options.includes('кот'), true);
  assert.equal(new Set(challenge.options).size, challenge.options.length);
});

test('parseSettingsAction extracts the selected group and action type', () => {
  const parsed = parseSettingsAction('select:42');

  assert.deepEqual(parsed, { type: 'select', target: 'select', chatId: 42, section: '', value: '42' });
});

test('isGroupMemberWithProfileChangePermission accepts creators and admins with change-info rights', () => {
  assert.equal(isGroupMemberWithProfileChangePermission({ status: 'creator', can_change_info: true }), true);
  assert.equal(isGroupMemberWithProfileChangePermission({ status: 'administrator', can_change_info: true }), true);
  assert.equal(isGroupMemberWithProfileChangePermission({ status: 'administrator', can_change_info: false, can_delete_messages: true }), true);
  assert.equal(isGroupMemberWithProfileChangePermission({ status: 'administrator', can_change_info: false }), false);
  assert.equal(isGroupMemberWithProfileChangePermission({ status: 'member', can_change_info: true }), false);
});

test('getGroupDisplayName resolves the active bot database group title', () => {
  const { database } = createBot();
  database.ensureGroup(42, 'Тестовая группа', null);

  assert.equal(getGroupDisplayName(42, 'fallback'), 'Тестовая группа');
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
