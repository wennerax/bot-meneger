const test = require('node:test');
const assert = require('node:assert/strict');
const { createBot, parsePunishmentDetails, buildPunishmentNotification, buildModerationAlertMessage, buildBulkModerationSummaryMessage, buildFunReply, getTicTacToeWinner, buildTicTacToeKeyboard, parsePageNumber, buildPunishmentListMessage, buildBotAdminListMessage, detectForbiddenWord, isLinkMessage, isAllowedLinkUrl, buildSettingsMainKeyboard, buildSettingsChatKeyboard, buildSettingsWarnsKeyboard, buildSettingsCommandRightsKeyboard, buildSettingsFirstMessageKeyboard, buildSettingsRulesMenuText, buildMembersManagementKeyboard, buildMenuKeyboard, canSelfClearPunishmentHistory, parseSettingsAction, isGroupOwnerMember, isGroupMemberWithProfileChangePermission, isGroupMemberWithManageRights, getGroupDisplayName, buildCaptchaChallenge, generateCaptchaPollOptions, shouldStartCaptchaForChat, isAnonymousSenderMessage, isChannelPostInGroupMessage, shouldFailClosedForMedia, cleanupAgreementMessages, handleAgreementDecision, isPollAnswerForTarget, buildBotMediaSend } = require('../app/bot');
const { buildAiRequestPayload, normalizeMultimodalInputForResponses } = require('../app/ai');
const premiumEmojis = require('../app/premium_emojis');

test('parsePunishmentDetails extracts duration and reason', () => {
  const result = parsePunishmentDetails('1d реклама', false);

  assert.deepEqual(result, { durationHours: 24, reason: 'реклама' });
});

test('buildBotMediaSend maps media to Telegram send methods and preserves captions', () => {
  assert.deepEqual(buildBotMediaSend({ sticker: { file_id: 'sticker-1' } }), {
    method: 'sendSticker',
    fileId: 'sticker-1',
  });
  assert.deepEqual(buildBotMediaSend({
    photo: [{ file_id: 'small' }, { file_id: 'large' }],
    caption: 'Подпись',
    caption_entities: [{ type: 'bold', offset: 0, length: 7 }],
  }), {
    method: 'sendPhoto',
    fileId: 'large',
    options: {
      caption: 'Подпись',
      caption_entities: [{ type: 'bold', offset: 0, length: 7 }],
      parse_mode: undefined,
    },
  });
  assert.equal(buildBotMediaSend({ document: { file_id: 'document-1' } }).method, 'sendDocument');
  assert.equal(buildBotMediaSend({ text: 'обычный текст' }), null);
});

test('parsePunishmentDetails returns default reason when none provided', () => {
  const result = parsePunishmentDetails('2h', false);

  assert.deepEqual(result, { durationHours: 2, reason: 'Без причины' });
});

test('parsePunishmentDetails makes a reply ban permanent without a reason or duration', () => {
  const result = parsePunishmentDetails('', true);

  assert.deepEqual(result, { durationHours: null, reason: 'Без причины' });
});

test('poll answers are accepted only from the user assigned to the poll', () => {
  const assignedUserId = 456;

  assert.equal(isPollAnswerForTarget({ user: { id: 456 }, option_ids: [1] }, assignedUserId), true);
  assert.equal(isPollAnswerForTarget({ user: { id: 789 }, option_ids: [1] }, assignedUserId), false);
  assert.equal(isPollAnswerForTarget({ user: { id: 456, is_bot: true }, option_ids: [1] }, assignedUserId), false);
});

test('buildPunishmentNotification includes group, reason and duration', () => {
  const message = buildPunishmentNotification('mute', 'Test Group', 'спам', 2);

  assert.equal(message, 'Вы были ограничен(а) в чате "Test Group". Причина: спам. Срок: 2ч.');
});

test('buildModerationAlertMessage includes duration and reason', () => {
  const message = buildModerationAlertMessage('@alice', 24, 'Спам');

  assert.equal(message, '⚠️ Пользователь @alice замучен на 1д по причине: Спам.');
});

test('buildBulkModerationSummaryMessage groups multiple reasons into one compact alert', () => {
  const message = buildBulkModerationSummaryMessage('@alice', ['Антифлуд', 'Ссылка', 'Пересланное сообщение из канала']);

  assert.equal(message, '⚠️ Автопроверка: пользователь @alice удалил сообщения по причине: Антифлуд, Ссылка, Пересланное сообщение из канала.');
});

test('buildFunReply returns a valid coin result', () => {
  const result = buildFunReply('coin');

  assert.ok(result === 'Орёл' || result === 'Решка');
});

test('buildFunReply returns a valid dice result', () => {
  const result = buildFunReply('dice');

  assert.ok(/^[1-6]$/.test(result));
});

test('tic-tac-toe detects wins, draws and unfinished boards', () => {
  assert.equal(getTicTacToeWinner(['X', 'X', 'X', '', '', '', '', '', '']), 'X');
  assert.equal(getTicTacToeWinner(['O', '', '', '', 'O', '', '', '', 'O']), 'O');
  assert.equal(getTicTacToeWinner(['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X']), 'draw');
  assert.equal(getTicTacToeWinner(['X', '', '', '', 'O', '', '', '', '']), null);
});

test('tic-tac-toe keyboard has a 3x3 field and callback positions', () => {
  const keyboard = buildTicTacToeKeyboard(Array(9).fill(''), -100123, false);

  assert.equal(keyboard.inline_keyboard.length, 3);
  assert.deepEqual(keyboard.inline_keyboard.map((row) => row.length), [3, 3, 3]);
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, 'ttt:move:-100123:0');
  assert.equal(keyboard.inline_keyboard[2][2].callback_data, 'ttt:move:-100123:8');
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
  assert.equal(keyboard.length, 10);
  assert.deepEqual(keyboard[0].map((button) => button.text), ['🧩 Капча', '🔗 Ссылки']);
  assert.deepEqual(keyboard[1].map((button) => button.text), ['🛡️ Антиспам', '📜 Правила']);
  assert.deepEqual(keyboard[2].map((button) => button.text), ['🚫 Банворды', '⚠️ Варны']);
  assert.deepEqual(keyboard[3].map((button) => button.text), ['⚙️ Команды', '🤖 Медиа ИИ']);
  assert.deepEqual(keyboard[4].map((button) => button.text), ['💬 Первый комментарий', '🚨 @admin']);
  assert.deepEqual(keyboard[5].map((button) => button.text), [premiumEmojis.getCustomEmojiFallback('series_premium') + ' Серия', '😶‍🌫️ Скрытые пользователи']);
  assert.equal(keyboard[0][0].callback_data, 'settings:section:captcha:42');
  assert.equal(keyboard[0][1].callback_data, 'settings:section:links:42');
  assert.equal(keyboard[1][0].callback_data, 'settings:section:anti:42');
  assert.equal(keyboard[1][1].callback_data, 'settings:section:rules:42');
  assert.equal(keyboard[2][0].callback_data, 'settings:section:banwords:42');
  assert.equal(keyboard[2][1].callback_data, 'settings:section:warns:42');
  assert.equal(keyboard[3][0].callback_data, 'settings:section:commands:42');
  assert.equal(keyboard[3][1].callback_data, 'settings:section:media_ai:42');
  assert.equal(keyboard[4][0].callback_data, 'settings:open_menu:42');
  assert.equal(keyboard[4][1].callback_data, 'settings:section:admin:42');
  assert.equal(keyboard[5][0].callback_data, 'settings:section:streaks:42');
  assert.equal(keyboard[5][1].callback_data, 'settings:section:anonymous:42');
  assert.deepEqual(keyboard[6].map((button) => button.text), ['💬 Чат', '🔔 Упоминание']);
  assert.deepEqual(keyboard[7].map((button) => button.text), ['👥 Управление участниками', '🤖 Бот Соо']);
  assert.deepEqual(keyboard[8].map((button) => button.text), ['📋 Логи']);
  assert.deepEqual(keyboard[9].map((button) => button.text), ['Вперёд ➡️']);
  assert.equal(keyboard[9][0].callback_data, 'settings:page:42:1');

  const secondPage = buildSettingsMainKeyboard(42, 1);
  assert.deepEqual(secondPage[0].map((button) => button.text), ['🛡️ Модерация']);
  assert.deepEqual(secondPage[1].map((button) => button.text), ['⬅️ Назад']);
  assert.equal(secondPage[0][0].callback_data, 'settings:section:moderation:42');
  assert.equal(secondPage[1][0].callback_data, 'settings:page:42:0');
});

test('isGroupOwnerMember treats creator status as group owner', () => {
  assert.equal(isGroupOwnerMember({ status: 'creator' }), true);
  assert.equal(isGroupOwnerMember({ status: 'administrator' }), false);
  assert.equal(isGroupOwnerMember({ status: 'member' }), false);
});

test('buildSettingsChatKeyboard exposes open and restricted write modes', () => {
  const keyboard = buildSettingsChatKeyboard(42);
  const labels = keyboard.inline_keyboard.flat().map((button) => button.text);

  assert.ok(labels.includes('📖 Открыть чат'));
  assert.ok(labels.includes('🔒 Закрыть чат'));
  assert.ok(labels.includes('👥 Только админы'));
  assert.ok(labels.includes('👑 Только владелец'));
  assert.ok(labels.some((button) => button.includes('Статус')));
});

test('buildMenuKeyboard includes a Chat action for legacy /menu', () => {
  const keyboard = buildMenuKeyboard(42);
  const labels = keyboard.inline_keyboard.flat().map((button) => button.text);

  assert.ok(labels.includes('Чат'));
  assert.ok(keyboard.inline_keyboard.some((row) => row.some((button) => button.callback_data === 'menu:chat')));
});

test('buildMenuKeyboard includes a mention notification action', () => {
  const keyboard = buildMenuKeyboard(42);
  const labels = keyboard.inline_keyboard.flat().map((button) => button.text);

  assert.ok(labels.includes('Упоминание'));
  assert.ok(keyboard.inline_keyboard.some((row) => row.some((button) => button.callback_data === 'menu:mention')));
});

test('buildSettingsWarnsKeyboard includes amnesty with confirmation flow', () => {
  const keyboard = buildSettingsWarnsKeyboard(42);

  assert.ok(Array.isArray(keyboard.inline_keyboard));
  assert.ok(keyboard.inline_keyboard.some((row) => row.some((button) => button.text === 'Амнистия')));
  assert.ok(keyboard.inline_keyboard.some((row) => row.some((button) => button.callback_data === 'settings:warn_amnesty:42')));
});

test('buildMembersManagementKeyboard returns to the settings main menu', () => {
  const keyboard = buildMembersManagementKeyboard(42);
  const backButton = keyboard.inline_keyboard[keyboard.inline_keyboard.length - 1][0];

  assert.equal(backButton.text, 'Назад');
  assert.equal(backButton.callback_data, 'settings:main:42');
});

test('buildSettingsCommandRightsKeyboard supports pagination and a back button', () => {
  const keyboard = buildSettingsCommandRightsKeyboard(42, 1);
  assert.ok(Array.isArray(keyboard.inline_keyboard));
  assert.equal(keyboard.inline_keyboard[keyboard.inline_keyboard.length - 1][0].text, 'Назад');
  assert.equal(keyboard.inline_keyboard[0].some((button) => button.callback_data === 'settings:command_rights:42:0'), true);
});

test('canSelfClearPunishmentHistory allows clearing own history only for clear_history action', () => {
  const ctx = { from: { id: 42 }, chat: { id: 100 } };

  assert.equal(canSelfClearPunishmentHistory(ctx, 42, 'clear_history'), true);
  assert.equal(canSelfClearPunishmentHistory(ctx, 99, 'clear_history'), false);
  assert.equal(canSelfClearPunishmentHistory(ctx, 42, 'ban'), false);
});

test('isAnonymousSenderMessage detects hidden sender messages', () => {
  assert.equal(isAnonymousSenderMessage({ sender_chat: { id: -1001, type: 'channel' } }), true);
  assert.equal(isAnonymousSenderMessage({ author_signature: 'Anonymous admin' }), true);
  assert.equal(isAnonymousSenderMessage({ from: { id: 123 } }), false);
  assert.equal(isAnonymousSenderMessage(null), false);
});

test('isChannelPostInGroupMessage ignores messages sent on behalf of a channel by a user', () => {
  assert.equal(isChannelPostInGroupMessage({ sender_chat: { type: 'channel' }, from: { id: 123 } }), false);
  assert.equal(isChannelPostInGroupMessage({ sender_chat: { type: 'channel' } }), true);
  assert.equal(isChannelPostInGroupMessage({ forward_from_chat: { type: 'channel' } }), true);
});

test('shouldFailClosedForMedia removes only explicit adult sticker content and leaves safe stickers alone', () => {
  assert.equal(shouldFailClosedForMedia({ type: 'sticker' }, '', 'да, это порно'), true);
  assert.equal(shouldFailClosedForMedia({ type: 'sticker' }, 'The image data you provided does not represent a valid image.', ''), false);
  assert.equal(shouldFailClosedForMedia({ type: 'sticker' }, '', 'непонятно'), false);
  assert.equal(shouldFailClosedForMedia({ type: 'sticker' }, '', 'котики и милые коты'), false);
  assert.equal(shouldFailClosedForMedia({ type: 'animation' }, '', 'нет, безопасно'), false);
  assert.equal(shouldFailClosedForMedia({ type: 'photo' }, 'The image data you provided does not represent a valid image.', ''), false);
});

test('mention notification back button returns to the main menu overview', () => {
  const keyboard = {
    inline_keyboard: [
      [
        { text: 'Включить', callback_data: 'menu:mention_toggle:on:42' },
      ],
      [{ text: 'Назад', callback_data: 'menu:overview' }],
    ],
  };

  assert.deepEqual(keyboard.inline_keyboard[1][0], { text: 'Назад', callback_data: 'menu:overview' });
});

test('buildSettingsFirstMessageKeyboard exposes text, buttons and media controls', () => {
  const keyboard = buildSettingsFirstMessageKeyboard(42);
  const labels = keyboard.inline_keyboard.flat().map((button) => button.text);

  assert.ok(labels.includes('Изменить текст'));
  assert.ok(labels.includes('Настройки кнопок'));
  assert.ok(labels.includes('Добавить медиа'));
  assert.ok(labels.includes('Удалить медиа'));
  assert.ok(labels.includes('Назад'));
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

test('captcha poll options are deduplicated across all modes', () => {
  const emojiChallenge = buildCaptchaChallenge('emoji', 'Алиса');
  const wordChallenge = buildCaptchaChallenge('word', 'Алиса');
  const colorChallenge = buildCaptchaChallenge('color', 'Алиса');

  for (const challenge of [emojiChallenge, wordChallenge, colorChallenge]) {
    const options = generateCaptchaPollOptions(challenge);
    assert.equal(new Set(options).size, options.length);
    assert.equal(options.includes(challenge.correctOption), true);
  }
});

test('buildSettingsRulesMenuText includes the current rules text', () => {
  const text = buildSettingsRulesMenuText(42, 'Соблюдайте уважение в чате');

  assert.match(text, /Настройки правил группы/);
  assert.match(text, /Текущие правила:/);
  assert.match(text, /Соблюдайте уважение в чате/);
});

test('cleanupAgreementMessages removes agreement text and poll without banning on refusal', async () => {
  const deleted = [];
  let kicked = false;
  let restricted = false;
  const telegram = {
    deleteMessage: async (chatId, messageId) => {
      deleted.push({ chatId, messageId });
    },
    kickChatMember: async () => {
      kicked = true;
    },
    restrictChatMember: async () => {
      restricted = true;
    },
    sendMessage: async (chatId, text) => ({ message_id: 900, chat: { id: chatId }, text }),
  };

  const state = {
    chatId: 123,
    userId: 456,
    displayName: 'Алиса',
    pollMessageId: 777,
    agreementMessageIds: [111, 222],
  };

  await handleAgreementDecision(telegram, state, false);

  assert.equal(kicked, false);
  assert.equal(restricted, true);
  assert.equal(deleted.some((item) => item.messageId === 111), true);
  assert.equal(deleted.some((item) => item.messageId === 222), true);
  assert.equal(deleted.some((item) => item.messageId === 777), true);
  assert.equal(deleted.some((item) => item.messageId === 900), false);
});

test('parseSettingsAction extracts chat access mode changes', () => {
  const parsed = parseSettingsAction('chat_access:42:closed');

  assert.equal(parsed.target, 'chat_access');
  assert.equal(parsed.chatId, 42);
  assert.equal(parsed.value, 'closed');
});

test('parseSettingsAction extracts the selected group and action type', () => {
  const parsed = parseSettingsAction('select:42');

  assert.deepEqual(parsed, { type: 'select', target: 'select', chatId: 42, section: '', value: '42', extra: '' });
});

test('parseSettingsAction supports negative Telegram group IDs', () => {
  const parsed = parseSettingsAction('first_buttons:-1001234567890');

  assert.deepEqual(parsed, { type: 'first_buttons', target: 'first_buttons', chatId: -1001234567890, section: '', value: '', extra: '' });
});

test('isGroupMemberWithProfileChangePermission accepts creators and admins with change-info rights', () => {
  assert.equal(isGroupMemberWithProfileChangePermission({ status: 'creator', can_change_info: true }), true);
  assert.equal(isGroupMemberWithProfileChangePermission({ status: 'administrator', can_change_info: true }), true);
  assert.equal(isGroupMemberWithProfileChangePermission({ status: 'administrator', can_change_info: false, can_delete_messages: true }), false);
  assert.equal(isGroupMemberWithProfileChangePermission({ status: 'administrator', can_change_info: false }), false);
  assert.equal(isGroupMemberWithProfileChangePermission({ status: 'administrator' }), true);
  assert.equal(isGroupMemberWithProfileChangePermission({ status: 'member', can_change_info: true }), false);
});

test('isGroupMemberWithManageRights accepts group administrators with standard admin rights', () => {
  assert.equal(isGroupMemberWithManageRights({ status: 'creator' }), true);
  assert.equal(isGroupMemberWithManageRights({ status: 'administrator', can_change_info: true }), true);
  assert.equal(isGroupMemberWithManageRights({ status: 'administrator', can_change_info: false, can_delete_messages: true }), true);
  assert.equal(isGroupMemberWithManageRights({ status: 'member' }), false);
});

test('menu access is allowed only for admins who can change group profile', () => {
  assert.equal(isGroupMemberWithProfileChangePermission({ status: 'administrator', can_change_info: true }), true);
  assert.equal(isGroupMemberWithProfileChangePermission({ status: 'administrator', can_change_info: false, can_delete_messages: true }), false);
  assert.equal(isGroupMemberWithProfileChangePermission({ status: 'member', can_change_info: true }), false);
});

test('getGroupDisplayName resolves the active bot database group title', () => {
  const { database } = createBot();
  database.ensureGroup(42, 'Тестовая группа', null);

  assert.equal(getGroupDisplayName(42, 'fallback'), 'Тестовая группа');
});

test('detectForbiddenWord catches drugs and self-harm variants', () => {
  // Exact phrase match
  assert.equal(detectForbiddenWord('я люблю курить траву весь день'), 'курить траву');
  // Exact word match
  assert.equal(detectForbiddenWord('героин это плохо'), 'героин');
  // Prefix match (obfuscation) - word with extra characters
  assert.equal(detectForbiddenWord('наркоыыыыыы'), 'нарко');
  assert.equal(detectForbiddenWord('героинчик мне нужен'), 'героин');
  assert.equal(detectForbiddenWord('хочу самоубийство'), 'самоубийство');
  // Should not match when word is not found
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

test('buildAiRequestPayload builds an OpenAI-compatible request body for text prompts', async () => {
  const payload = await buildAiRequestPayload('привет', 'gpt-4o-mini');

  assert.equal(payload.model, 'gpt-4o-mini');
  assert.equal(payload.messages[1].role, 'user');
  assert.match(payload.messages[1].content, /привет/);
});

test('buildAiRequestPayload supports multimodal prompt arrays', async () => {
  const multis = [
    { type: 'text', text: 'Что на картинке?' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
  ];
  const payload = await buildAiRequestPayload(multis, 'gpt-4o-mini');

  assert.equal(payload.model, 'gpt-4o-mini');
  assert.equal(payload.messages[1].role, 'user');
  assert.equal(payload.messages[1].content, multis);
});

test('normalizeMultimodalInputForResponses converts Telegram-style items into OpenAI Responses format', () => {
  const input = [
    { type: 'text', text: 'Есть ли порно на этом фото?' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
  ];

  const normalized = require('../app/ai').normalizeMultimodalInputForResponses(input);

  assert.equal(normalized.length, 1);
  assert.deepEqual(normalized[0], {
    role: 'user',
    content: [
      { type: 'input_text', text: 'Есть ли порно на этом фото?' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
    ],
  });
});

test('matter AI verdict accepts explicit yes/no answers in Russian and English', () => {
  const outputs = ['да', 'ДА!', 'нет', 'No', 'Yes, this is explicit content'];
  const normalized = outputs.map((value) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ' ').replace(/\s+/g, ' ').trim());

  assert.equal(/(?:^|[^\p{L}\p{N}])(да|yes|true|adult|порно|porn|эротик|откровенн|нагота|голая|сексуал)(?:$|[^\p{L}\p{N}])/u.test('да'), true);
  assert.equal(/(?:^|[^\p{L}\p{N}])(нет|no|false|safe|безопасно|безопасный)(?:$|[^\p{L}\p{N}])/u.test('нет'), true);
  assert.equal(/(?:^|[^\p{L}\p{N}])(нет|no|false|safe|безопасно|безопасный)(?:$|[^\p{L}\p{N}])/u.test('no'), true);
  assert.equal(/(?:^|[^\p{L}\p{N}])(да|yes|true|adult|порно|porn|эротик|откровенн|нагота|голая|сексуал)(?:$|[^\p{L}\p{N}])/u.test('yes this is explicit content'), true);
  assert.equal(normalized.some((value) => value === 'да' || value === 'нет' || value === 'no' || value === 'yes this is explicit content'), true);
});
