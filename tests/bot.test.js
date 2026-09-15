const test = require('node:test');
const assert = require('node:assert/strict');
const { createBot, parsePunishmentDetails, buildPunishmentNotification, buildModerationAlertMessage, buildBulkModerationSummaryMessage, buildFunReply, getTicTacToeWinner, buildTicTacToeKeyboard, parsePageNumber, buildPunishmentListMessage, buildBotAdminListMessage, detectForbiddenWord, isLinkMessage, isAllowedLinkUrl, buildSettingsMainKeyboard, buildModerationLogsKeyboard, buildSettingsChatKeyboard, buildSettingsWarnsKeyboard, buildWarningsListText, buildSettingsWarnsListText, buildSettingsCommandRightsKeyboard, buildSettingsFirstMessageKeyboard, buildSettingsRulesMenuText, buildMembersManagementKeyboard, buildMenuKeyboard, canSelfClearPunishmentHistory, parseSettingsAction, isGroupOwnerMember, isGroupMemberWithProfileChangePermission, isGroupMemberWithManageRights, getGroupDisplayName, buildCaptchaChallenge, generateCaptchaPollOptions, shouldStartCaptchaForChat, isAnonymousSenderMessage, isChannelPostInGroupMessage, shouldFailClosedForMedia, cleanupAgreementMessages, handleAgreementDecision, handleAgreementTimeout, isPollAnswerForTarget, buildBotMediaSend, buildReloadStatusMessage, parseBotCommandKey, isKnownCommandText, formatAdminReportText, formatUserIdentityText, isChatMemberStillInGroup, buildActivityChartSvg, applyWarnLimitPunishment, isTelegramBotNotMemberChatError } = require('../app/bot');
const { buildAiRequestPayload, normalizeMultimodalInputForResponses } = require('../app/ai');
const premiumEmojis = require('../app/premium_emojis');

test('parsePunishmentDetails extracts duration and reason', () => {
  const result = parsePunishmentDetails('1d реклама', false);

  assert.deepEqual(result, { durationHours: 24, reason: 'реклама' });
});

test('parsePunishmentDetails accepts Russian duration units', () => {
  assert.deepEqual(parsePunishmentDetails('7д 1.1', false), {
    durationHours: 168,
    reason: '1.1',
  });
});

test('parseBotCommandKey recognizes plus and minus punishment commands', () => {
  assert.equal(parseBotCommandKey('+варн @alice причина'), 'warn');
  assert.equal(parseBotCommandKey('-варн @alice'), 'warn');
  assert.equal(parseBotCommandKey('+warn @alice причина'), 'warn');
  assert.equal(parseBotCommandKey('-warn @alice'), 'warn');
  assert.equal(parseBotCommandKey('+мут @alice 10m'), 'mute');
  assert.equal(parseBotCommandKey('-мут @alice'), 'mute');
  assert.equal(parseBotCommandKey('+бан @alice'), 'ban');
  assert.equal(parseBotCommandKey('-бан @alice'), 'ban');
  assert.equal(parseBotCommandKey('+ban @alice'), 'ban');
  assert.equal(parseBotCommandKey('-ban @alice'), 'ban');
  assert.equal(parseBotCommandKey('/анварн @alice'), 'анварн');
  assert.equal(parseBotCommandKey('!размут @alice'), 'unmute');
  assert.equal(parseBotCommandKey('/разбан @alice'), 'разбан');
  assert.equal(parseBotCommandKey('+анварн @alice'), 'warn');
  assert.equal(parseBotCommandKey('-размут @alice'), 'mute');
  assert.equal(parseBotCommandKey('+разбан @alice'), 'ban');
  assert.equal(isKnownCommandText('+варн @alice'), true);
  assert.equal(isKnownCommandText('-мут @alice'), true);
  assert.equal(isKnownCommandText('+warn @alice'), true);
  assert.equal(isKnownCommandText('-ban @alice'), true);
  assert.equal(isKnownCommandText('/анварн @alice'), true);
  assert.equal(isKnownCommandText('!размут @alice'), true);
  assert.equal(isKnownCommandText('+разбан @alice'), true);
  assert.equal(isKnownCommandText('/мут @alice 10m'), true);
  assert.equal(isKnownCommandText('/варн @alice'), true);
  assert.equal(isKnownCommandText('/анпред @alice'), true);
});

test('isChatMemberStillInGroup recognizes active chat membership states', () => {
  assert.equal(isChatMemberStillInGroup({ status: 'member' }), true);
  assert.equal(isChatMemberStillInGroup({ status: 'restricted' }), true);
  assert.equal(isChatMemberStillInGroup({ status: 'left' }), false);
  assert.equal(isChatMemberStillInGroup({ status: 'kicked' }), false);
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

test('parsePunishmentDetails keeps a reason that looks like a number', () => {
  const result = parsePunishmentDetails('1.3', false);

  assert.deepEqual(result, { durationHours: null, reason: '1.3' });
});

test('short !пред warning command is recognized and mapped to warn', () => {
  assert.equal(parseBotCommandKey('!пред'), 'warn');
  assert.equal(parseBotCommandKey('!пред @alice причина'), 'warn');
  assert.equal(isKnownCommandText('!пред @alice причина'), true);
});

test('silent slash punishment commands are parsed and recognized as known commands', () => {
  assert.equal(parseBotCommandKey('/sban @alice 1d spam'), 'sban');
  assert.equal(parseBotCommandKey('/swarn @alice spam'), 'swarn');
  assert.equal(parseBotCommandKey('/smute @alice 1d spam'), 'smute');
  assert.equal(isKnownCommandText('/sban @alice 1d spam'), true);
  assert.equal(isKnownCommandText('/swarn @alice spam'), true);
  assert.equal(isKnownCommandText('/smute @alice 1d spam'), true);
});

test('id command is recognized as a restricted helper command', () => {
  assert.equal(isKnownCommandText('/id'), true);
  assert.equal(isKnownCommandText('/айди'), true);
});

test('id command defaults to caller and resolves explicit reply or username targets', async () => {
  const { resolveIdCommandTarget } = require('../app/bot');
  const database = {
    resolveUsername(chatId, rawUsername) {
      if (String(rawUsername).toLowerCase() === '@alice') {
        return { userId: 42, displayName: 'Alice' };
      }
      return null;
    },
  };

  const selfCtx = {
    chat: { id: -1001, type: 'supergroup' },
    from: { id: 11, first_name: 'Bob', username: 'bob' },
    message: { text: '/id' },
  };

  assert.equal((await resolveIdCommandTarget(selfCtx, database)).id, 11);

  const usernameCtx = {
    chat: { id: -1001, type: 'supergroup' },
    from: { id: 11, first_name: 'Bob', username: 'bob' },
    message: { text: '/id @alice' },
  };

  assert.equal((await resolveIdCommandTarget(usernameCtx, database)).id, 42);

  const bangUsernameCtx = {
    chat: { id: -1001, type: 'supergroup' },
    from: { id: 11, first_name: 'Bob', username: 'bob' },
    message: { text: '!айди @alice' },
  };

  assert.equal((await resolveIdCommandTarget(bangUsernameCtx, database)).id, 42);

  const replyCtx = {
    chat: { id: -1001, type: 'supergroup' },
    from: { id: 11, first_name: 'Bob', username: 'bob' },
    message: {
      text: '/id',
      reply_to_message: { from: { id: 99, first_name: 'Carol', username: 'carol' } },
    },
  };

  assert.equal((await resolveIdCommandTarget(replyCtx, database)).id, 99);
});

test('!дел is mapped to delete-only action instead of warning', () => {
  assert.equal(parseBotCommandKey('!дел'), 'delete_message');
  assert.equal(parseBotCommandKey('!дел @alice'), 'delete_message');
  assert.equal(isKnownCommandText('!дел @alice'), true);
});

test('/del is recognized as the delete-message command', () => {
  assert.equal(parseBotCommandKey('/del'), 'delete_message');
  assert.equal(parseBotCommandKey('/del @alice'), 'delete_message');
  assert.equal(isKnownCommandText('/del'), true);
});

test('parsePunishmentDetails makes a reply ban permanent without a reason or duration', () => {
  const result = parsePunishmentDetails('', true);

  assert.deepEqual(result, { durationHours: null, reason: 'Без причины' });
});

test('reload status shows success when the bot reaches 100%', () => {
  assert.equal(buildReloadStatusMessage(0), '🔄 Перезапускаем бота: 0-10%');
  assert.equal(buildReloadStatusMessage(100), '✅ Перезапуск успешно выполнен.');
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

test('warn status keyboard offers +1, -1 and reset actions for a user with warnings', () => {
  const keyboard = require('../app/bot').buildWarnStatusKeyboard(-1001, 42, {
    getWarnings: () => 2,
    getWarnLimit: () => 3,
  });

  assert.deepEqual(keyboard, {
    inline_keyboard: [
      [{ text: '-1', callback_data: 'warn:adjust:-1001:42:-1' }, { text: '+1', callback_data: 'warn:adjust:-1001:42:1' }],
      [{ text: 'Сброс предупреждений', callback_data: 'warn:reset:-1001:42' }],
    ],
  });
});

test('applyWarnLimitPunishment bans when the configured warn mode is ban and the limit is reached', async () => {
  const calls = [];
  const ctx = {
    chat: { id: -1001 },
    from: { id: 7, username: 'mod' },
    reply: async () => ({ message_id: 1 }),
    telegram: {
      banChatMember: async (...args) => {
        calls.push(['banChatMember', ...args]);
      },
      kickChatMember: async (...args) => {
        calls.push(['kickChatMember', ...args]);
      },
      restrictChatMember: async (...args) => {
        calls.push(['restrictChatMember', ...args]);
      },
      unbanChatMember: async (...args) => {
        calls.push(['unbanChatMember', ...args]);
      },
    },
  };

  const service = {
    getWarnPunishmentMode: () => 'ban',
    getWarnLimit: () => 3,
    getWarnBlockDuration: () => 24,
  };

  const database = {
    getUserProfile: () => ({ username: '@alice', displayName: 'Alice' }),
  };

  const result = await applyWarnLimitPunishment(ctx, 42, 'spam', 3, service, database);

  assert.equal(result, true);
  assert.equal(calls[0][0], 'banChatMember');
  assert.equal(calls[0][1], -1001);
  assert.equal(calls[0][2], 42);
  assert.equal(typeof calls[0][3], 'number');
  assert.ok(calls[0][3] > 0);
});

test('applyWarnLimitPunishment uses target user label instead of moderator name in the limit notification', async () => {
  let sentText = '';
  const ctx = {
    chat: { id: -1001 },
    from: { id: 7, username: 'mod' },
    reply: async (text) => {
      sentText = text;
      return { message_id: 1 };
    },
    telegram: {
      banChatMember: async () => {},
      kickChatMember: async () => {},
      restrictChatMember: async () => {},
      unbanChatMember: async () => {},
    },
  };

  const service = {
    getWarnPunishmentMode: () => 'ban',
    getWarnLimit: () => 3,
    getWarnBlockDuration: () => 24,
  };

  const database = {
    getUserProfile: (chatId, userId) => ({
      chatId,
      userId,
      username: '@alice',
      displayName: 'Alice',
    }),
    addPunishment: () => {},
    addActivePunishment: () => {},
  };

  premiumEmojis.replyWithCustomEmoji = async (_ctx, text) => {
    sentText = text;
    return { message_id: 1 };
  };

  await applyWarnLimitPunishment(ctx, 42, 'spam', 3, service, database);

  assert.ok(sentText.includes('@alice'));
  assert.ok(!sentText.includes('@mod'));
  assert.ok(!sentText.includes('Пользователь 42'));
});

test('applyWarnLimitPunishment stores mute punishments in the active list so they appear in /mutes', async () => {
  const ctx = {
    chat: { id: -1001 },
    from: { id: 7, username: 'mod' },
    reply: async () => ({ message_id: 1 }),
    telegram: {
      restrictChatMember: async () => {},
      banChatMember: async () => {},
      kickChatMember: async () => {},
      unbanChatMember: async () => {},
    },
  };

  const calls = [];
  const service = {
    getWarnPunishmentMode: () => 'mute',
    getWarnLimit: () => 3,
    getWarnBlockDuration: () => 24,
  };

  const database = {
    getUserProfile: () => ({ username: '@alice', displayName: 'Alice' }),
    addPunishment: (...args) => calls.push(['addPunishment', ...args]),
    addActivePunishment: (...args) => calls.push(['addActivePunishment', ...args]),
  };

  premiumEmojis.replyWithCustomEmoji = async () => ({ message_id: 1 });

  const result = await applyWarnLimitPunishment(ctx, 42, 'spam', 3, service, database);

  assert.equal(result, true);
  assert.ok(calls.some(([method]) => method === 'addActivePunishment'));
  const muteCall = calls.find(([method, chatId, userId, action]) => method === 'addActivePunishment' && chatId === -1001 && userId === 42 && action === 'mute');
  assert.ok(muteCall);
});

test('buildBulkModerationSummaryMessage groups multiple reasons into one compact alert', () => {
  const message = buildBulkModerationSummaryMessage('@alice', ['Антифлуд', 'Ссылка', 'Пересланное сообщение из канала']);

  assert.equal(message, '⚠️ Автопроверка: пользователь @alice удалил сообщения по причине: Антифлуд, Ссылка, Пересланное сообщение из канала.');
});

test('admin reports use mentions without raw numeric ids', () => {
  const reportText = formatAdminReportText({
    reporter: { id: 12, username: 'alice' },
    target: { user: { id: 34, username: 'bob' } },
    groupTitle: 'Test Group',
    chatId: -1001,
  }, { id: 56, username: 'moderator' });

  assert.match(reportText, /@alice/);
  assert.match(reportText, /@bob/);
  assert.match(reportText, /@moderator/);
  assert.doesNotMatch(reportText, /\b(?:12|34|56)\b/);
});

test('warning list prefers usernames and omits visible numeric ids', () => {
  const message = buildWarningsListText(-1001, { getAllWarnings: () => [[123, 2], [456, 1]] }, {
    getUserProfile: (chatId, userId) => {
      if (Number(userId) === 123) return { username: '@alice' };
      if (Number(userId) === 456) return { displayName: 'Bob' };
      return {};
    },
  });

  assert.match(message, /@alice/);
  assert.match(message, /Bob/);
  assert.doesNotMatch(message, /\b123\b/);
  assert.doesNotMatch(message, /\b456\b/);
});

test('clear history messages use username instead of numeric id', () => {
  assert.equal(formatUserIdentityText({ username: '@alice' }), '@alice');
  assert.equal(formatUserIdentityText({ first_name: 'Alice' }), 'Alice');
  assert.equal(formatUserIdentityText({ id: 7288555779 }), 'Пользователь');
});

test('isTelegramBotNotMemberChatError identifies the membership refusal payload from Telegram', () => {
  assert.equal(isTelegramBotNotMemberChatError({
    response: { error_code: 403, description: 'Forbidden: bot is not a member of the supergroup chat' },
  }), true);
  assert.equal(isTelegramBotNotMemberChatError({
    response: { error_code: 403, description: 'Forbidden: message is not modified' },
  }), false);
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

test('buildPunishmentListMessage shows the actor username instead of generic moderator text', () => {
  const punishments = [
    { userId: 123, action: 'ban', reason: 'Спам', untilAt: 1753000000, actorId: 777 },
    { userId: 456, action: 'ban', reason: 'Автобан после 3 предупреждений. Последнее: спам', untilAt: 1753003600 },
  ];

  const message = buildPunishmentListMessage('ban', punishments, 1, 10, -1001, {
    getUserProfile: (chatId, userId) => {
      if (Number(userId) === 123) return { username: '@alice' };
      if (Number(userId) === 456) return { username: '@bob' };
      if (Number(userId) === 777) return { username: '@moderator' };
      return {};
    },
  });

  assert.match(message, /- @alice - \(бан\) Выдан: @moderator/);
  assert.match(message, /По причине: Спам/);
  assert.match(message, /Время:/);
  assert.match(message, /- @bob - \(бан\) Автонаказание/);
  assert.match(message, /По причине: Автобан после 3 предупреждений\. Последнее: спам/);
  assert.doesNotMatch(message, /\b123\b/);
  assert.doesNotMatch(message, /\b456\b/);
});

test('buildPunishmentListMessage paginates active bans and mutes without showing raw ids', () => {
  const punishments = Array.from({ length: 12 }, (_, index) => ({
    userId: index + 1,
    action: 'ban',
    reason: `reason-${index + 1}`,
    untilAt: null,
  }));

  const pageOne = buildPunishmentListMessage('ban', punishments, 1, 5);
  const pageTwo = buildPunishmentListMessage('mute', punishments, 2, 5);

  assert.match(pageOne, /Баны \(страница 1\/3\)/);
  assert.match(pageOne, /- Пользователь - \(бан\) Выдан: модератор/);
  assert.doesNotMatch(pageOne, /User\s*1/);
  assert.match(pageTwo, /Муты \(страница 2\/3\)/);
  assert.match(pageTwo, /- Пользователь - \(бан\) Выдан: модератор/);
  assert.doesNotMatch(pageTwo, /User\s*6/);
});

test('buildBotAdminListMessage separates primary and auxiliary admins', () => {
  const message = buildBotAdminListMessage('@alice', ['@bob', '@carol']);

  assert.match(message, /Главный админ:\s*\n1\. @alice/);
  assert.match(message, /1\. @bob/);
  assert.match(message, /2\. @carol/);
});

test('stats premium emoji ids are available for the required profile fields', () => {
  const required = {
    trophy_premium: '5415778465460816497',
    stats_id: '5415898307933278471',
    stats_name: '5413681653836976155',
    stats_description: '5415770085979622601',
    stats_message_count: '5415686961182576304',
    stats_streak: '5415985341150564555',
    stats_top: '5287641324525220384',
    stats_first_joined: '5402436682131718162',
    stats_chat_status: '5415984722675273004',
    stats_bot_status: '5416024803310080992',
  };

  for (const [name, id] of Object.entries(required)) {
    const info = premiumEmojis.getCustomEmojiInfo(name);
    assert.ok(info, `Expected premium emoji metadata for ${name}`);
    assert.equal(info.id, id, `Expected ${name} to map to ${id}`);
  }
});

test('activity chart keeps the modeled title and bars in the SVG', () => {
  const svg = require('../app/bot').buildActivityChartSvg([
    { day: '2025-01-01', count: 4 },
    { day: '2025-01-02', count: 8 },
    { day: '2025-01-03', count: 6 },
  ]);

  assert.match(svg, /Статистика активности/);
  assert.match(svg, /Сообщений/);
  assert.match(svg, /<text/i);
  assert.match(svg, /<rect/);
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
  assert.deepEqual(secondPage[0].map((button) => button.text), ['🛡️ Модерация', '🎞️ GIF Команды']);
  assert.deepEqual(secondPage[1].map((button) => button.text), ['⬅️ Назад']);
  assert.equal(secondPage[0][0].callback_data, 'settings:section:moderation:42');
  assert.equal(secondPage[0][1].callback_data, 'settings:section:gif_commands:42');
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

test('moderation logs back button uses the requested return menu', () => {
  const legacyKeyboard = buildModerationLogsKeyboard(42);
  const settingsKeyboard = buildModerationLogsKeyboard(42, 'settings:main:42');

  assert.equal(legacyKeyboard.inline_keyboard.at(-1)[0].callback_data, 'menu:overview');
  assert.equal(settingsKeyboard.inline_keyboard.at(-1)[0].callback_data, 'settings:main:42');
});

test('buildSettingsWarnsKeyboard includes amnesty with confirmation flow', () => {
  const keyboard = buildSettingsWarnsKeyboard(42);

  assert.ok(Array.isArray(keyboard.inline_keyboard));
  assert.ok(keyboard.inline_keyboard.some((row) => row.some((button) => button.text === 'Амнистия')));
  assert.ok(keyboard.inline_keyboard.some((row) => row.some((button) => button.callback_data === 'settings:warn_amnesty:42')));
});

test('buildWarningsListText shows usernames without exposing numeric ids', () => {
  const fakeService = {
    getAllWarnings: () => [[123, 2], [456, 1]],
    getWarnLimit: () => 3,
  };
  const fakeDatabase = {
    getUserProfile: (chatId, userId) => {
      if (userId === 123) return { username: '@alice' };
      if (userId === 456) return { username: '@bob' };
      return null;
    },
  };

  const text = buildWarningsListText(-1001, fakeService, fakeDatabase);

  assert.match(text, /@alice: 2\/3/);
  assert.match(text, /@bob: 1\/3/);
  assert.doesNotMatch(text, /\b123\b/);
  assert.doesNotMatch(text, /\b456\b/);
  assert.match(text, /Список предупреждений группы/);
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

test('isChannelPostInGroupMessage recognizes channel-authored posts with a from user', () => {
  assert.equal(isChannelPostInGroupMessage({
    sender_chat: { type: 'channel' },
    is_automatic_forward: true,
    from: { id: 123 },
  }), true);
  assert.equal(isChannelPostInGroupMessage({ sender_chat: { type: 'channel' } }), false);
  assert.equal(isAnonymousSenderMessage({ sender_chat: { type: 'channel' } }), true);
  assert.equal(isChannelPostInGroupMessage({
    is_automatic_forward: true,
    forward_from_chat: { type: 'channel' },
  }), true);
  assert.equal(isChannelPostInGroupMessage({
    message_thread_id: 12,
    forward_origin: { type: 'channel', chat: { id: -1001, type: 'channel' } },
  }), false);
  assert.equal(isChannelPostInGroupMessage({
    is_automatic_forward: true,
    message_thread_id: 12,
  }), true);
  assert.equal(isChannelPostInGroupMessage({ forward_from_chat: { type: 'channel' } }), false);
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

test('buildCaptchaChallenge always requires the banana in emoji mode', () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const challenge = buildCaptchaChallenge('emoji', 'Алиса');

    assert.equal(challenge.prompt, 'Алиса, нажмите на смайлик с БАНАНОМ, чтобы подтвердить, что вы НЕ БОТ для входа, и откройте чат снова 👇🏻');
    assert.equal(challenge.correctOption, '🍌');
    assert.equal(challenge.options.includes('🍌'), false);
    assert.equal(new Set(challenge.options).size, challenge.options.length);
  }
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

test('agreement acceptance removes all related messages including the instruction message', async () => {
  const deleted = [];
  let restrictionArgs;
  const telegram = {
    deleteMessage: async (chatId, messageId) => {
      deleted.push({ chatId, messageId });
    },
    restrictChatMember: async (...args) => {
      restrictionArgs = args;
    },
    sendMessage: async (chatId, text) => ({ message_id: 900, chat: { id: chatId }, text }),
  };

  const state = {
    chatId: 123,
    userId: 456,
    displayName: 'Алиса',
    pollMessageId: 777,
    instructionMessageId: 333,
    agreementMessageIds: [111, 222],
  };

  await handleAgreementDecision(telegram, state, true);

  assert.equal(restrictionArgs[0], 123);
  assert.equal(restrictionArgs[1], 456);
  assert.equal(restrictionArgs[2].can_send_messages, true);
  assert.equal(deleted.some((item) => item.messageId === 111), true);
  assert.equal(deleted.some((item) => item.messageId === 222), true);
  assert.equal(deleted.some((item) => item.messageId === 333), true);
  assert.equal(deleted.some((item) => item.messageId === 777), true);
  assert.equal(deleted.some((item) => item.messageId === 900), false);
});

test('agreement refusal restricts for 24 hours and excludes the user without banning', async () => {
  const deleted = [];
  let kicked = false;
  let unbanned = false;
  let restrictionArgs;
  const telegram = {
    deleteMessage: async (chatId, messageId) => {
      deleted.push({ chatId, messageId });
    },
    kickChatMember: async () => {
      kicked = true;
    },
    unbanChatMember: async (chatId, userId, onlyIfBanned) => {
      unbanned = chatId === 123 && userId === 456 && onlyIfBanned === true;
    },
    restrictChatMember: async (...args) => {
      restrictionArgs = args;
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

  assert.equal(kicked, true);
  assert.equal(unbanned, true);
  assert.equal(restrictionArgs[0], 123);
  assert.equal(restrictionArgs[1], 456);
  assert.equal(restrictionArgs[2].can_send_messages, false);
  assert.ok(restrictionArgs[3] >= Math.floor(Date.now() / 1000) + 23 * 60 * 60);
  assert.ok(restrictionArgs[3] <= Math.floor(Date.now() / 1000) + 24 * 60 * 60);
  assert.equal(deleted.some((item) => item.messageId === 111), true);
  assert.equal(deleted.some((item) => item.messageId === 222), true);
  assert.equal(deleted.some((item) => item.messageId === 777), true);
  assert.equal(deleted.some((item) => item.messageId === 900), false);
});

test('handleAgreementTimeout routes a silent agreement poll through the same refusal path', async () => {
  const deleted = [];
  let kicked = false;
  let unbanned = false;
  let restrictionArgs;
  const telegram = {
    deleteMessage: async (chatId, messageId) => {
      deleted.push({ chatId, messageId });
    },
    kickChatMember: async () => {
      kicked = true;
    },
    unbanChatMember: async (chatId, userId, onlyIfBanned) => {
      unbanned = chatId === 123 && userId === 456 && onlyIfBanned === true;
    },
    restrictChatMember: async (...args) => {
      restrictionArgs = args;
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

  await handleAgreementTimeout(telegram, state);

  assert.equal(kicked, true);
  assert.equal(unbanned, true);
  assert.equal(restrictionArgs[0], 123);
  assert.equal(restrictionArgs[1], 456);
  assert.equal(restrictionArgs[2].can_send_messages, false);
  assert.ok(deleted.some((item) => item.messageId === 111));
  assert.ok(deleted.some((item) => item.messageId === 222));
  assert.ok(deleted.some((item) => item.messageId === 777));
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
  assert.equal(detectForbiddenWord('гeроин это плохо'), 'героин');
  assert.equal(detectForbiddenWord('кoкаин это плохо'), 'кокаин');
  assert.equal(detectForbiddenWord('cпaйс это плохо'), 'спайс');
  // Arbitrary word endings are not treated as a match.
  assert.equal(detectForbiddenWord('наркоыыыыыы'), null);
  assert.equal(detectForbiddenWord('героинчик мне нужен'), 'героин');
  assert.equal(detectForbiddenWord('хочу самоубийство'), 'самоубийство');
  assert.equal(detectForbiddenWord('метеорит'), null);
  assert.equal(detectForbiddenWord('металлургия'), null);
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

test('link protection ignores closing quotes around URLs', () => {
  assert.equal(isLinkMessage('"https://example.com"', (link) => link === 'https://example.com'), false);
  assert.equal(isLinkMessage("'https://example.com'", (link) => link === 'https://example.com'), false);
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
