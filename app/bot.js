const path = require('node:path');
const { Telegraf } = require('telegraf');
const sharp = require('sharp');
const { loadConfig, getMiniAppPort, detectPublicMiniAppUrl } = require('./config');
const UserService = require('./services/user_service');
const ModerationService = require('./services/moderation_service');
const Database = require('./services/database');
const { getFunnyDescription } = require('./services/moderation_service');
const { getMentionText, resolveUsernameTarget } = require('./services/username_service');
const premiumEmojis = require('./premium_emojis');

const defaultModerationService = new ModerationService();
let activeDatabase = null;
let activeModerationService = null;
let activeConfig = null;
const adminReports = new Map();

// Установите сюда ID группы модераторов, в которую будут приходить уведомления при включенном уведомлении администраторов.
// Пример: const ADMIN_NOTIFICATION_GROUP_ID = -1001234567890;
const ADMIN_NOTIFICATION_GROUP_ID = 0;

function normalizeUrlPattern(value) {
  return String(value || '').trim().toLowerCase().replace(/^https?:\/\//i, '').replace(/^www\./i, '');
}

function getLinkCandidates(text) {
  return Array.from(String(text || '').matchAll(/(?:https?:\/\/|www\.)\S+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?/ig), (match) => {
    const raw = match[0].replace(/[.,;:!?)+\]}]+$/g, '');
    return raw;
  });
}

function isLinkMessage(text, allowLinkPredicate) {
  const links = getLinkCandidates(text);
  if (links.length === 0) {
    return false;
  }
  const predicate = typeof allowLinkPredicate === 'function'
    ? allowLinkPredicate
    : (link) => defaultModerationService.isAllowedLink(0, link);
  return links.some((link) => !predicate(link));
}

function isAllowedLinkUrl(value) {
  return defaultModerationService.isAllowedLink(0, value);
}

function detectForbiddenWord(text) {
  return defaultModerationService.findBanWord(0, text);
}

function isChannelPostInGroupMessage(message = {}) {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const isSenderChatChannel = message.sender_chat?.type === 'channel';
  const isForwardedFromChannel = message.forward_from_chat?.type === 'channel';
  const hasRegularUser = Boolean(message.from && typeof message.from === 'object' && message.from.id);
  
  // Поддержка forum topics: если есть message_thread_id и нет from, это пост в topic
  const isTopicPost = message.message_thread_id && message.message_thread_id !== 0 && !hasRegularUser;

  return (isTopicPost || !hasRegularUser) && (isSenderChatChannel || isForwardedFromChannel);
}

function isAnonymousSenderMessage(message = {}) {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const senderChat = message.sender_chat;
  const hasSenderChat = Boolean(senderChat && typeof senderChat === 'object' && senderChat.id);
  const hasAuthorSignature = Boolean(message.author_signature);

  return hasSenderChat || hasAuthorSignature;
}

function detectForwardedMessageCategory(message = {}) {
  if (!message || typeof message !== 'object') {
    return null;
  }

  // Проверяем, есть ли пересланное сообщение с источником (чатом)
  if (message.forward_from_chat) {
    const chatType = String(message.forward_from_chat.type || '').toLowerCase();
    if (chatType === 'channel') {
      return 'channels';
    }
    if (chatType === 'group' || chatType === 'supergroup') {
      return 'groups';
    }
  }

  // Проверяем, есть ли пересланное сообщение от пользователя
  if (message.forward_from) {
    const user = message.forward_from;
    if (user.is_bot === true) {
      return 'bots';
    }
    return 'users';
  }

  return null;
}

function getGroupDisplayName(chatId, fallback = null) {
  const id = Number(chatId);
  if (!Number.isFinite(id)) {
    return fallback || 'группа';
  }
  const database = activeDatabase;
  if (!database?.data?.groups) {
    return fallback || String(id);
  }
  const groupRecord = database.data.groups?.[id];
  return groupRecord?.title || fallback || String(id);
}

function buildMutePermissions(enabled = true) {
  return {
    can_send_messages: enabled,
    can_send_media_messages: enabled,
    can_send_polls: enabled,
    can_send_other_messages: enabled,
    can_add_web_page_previews: enabled,
    can_change_info: false,
    can_invite_users: false,
    can_pin_messages: false,
    can_manage_topics: false,
  };
}

async function cleanupAgreementMessages(telegram, chatId, messageIds = []) {
  if (!telegram || !chatId || !Array.isArray(messageIds)) {
    return;
  }

  const uniqueIds = [...new Set(messageIds.filter((messageId) => Number.isFinite(Number(messageId)) && Number(messageId) > 0))];
  for (const messageId of uniqueIds) {
    try {
      await telegram.deleteMessage(chatId, Number(messageId));
    } catch (deleteError) {
      // ignore deletion errors for already-removed agreement messages
    }
  }
}

async function handleAgreementDecision(telegram, state, accepted) {
  if (!state || !telegram) {
    return;
  }

  const messageIds = Array.isArray(state.agreementMessageIds) ? [...state.agreementMessageIds] : [];
  if (state.pollMessageId) {
    messageIds.push(state.pollMessageId);
  }

  await cleanupAgreementMessages(telegram, state.chatId, messageIds);

  if (accepted) {
    await telegram.restrictChatMember(state.chatId, state.userId, buildMutePermissions(true));
    const acceptedMessage = await telegram.sendMessage(state.chatId, `Пользователь ${state.displayName} подтвердил соглашение и получил доступ к чату.`);
    scheduleDeleteMessage(telegram, state.chatId, acceptedMessage?.message_id);
    return;
  }

  await telegram.restrictChatMember(state.chatId, state.userId, buildMutePermissions(false));
  const rejectedMessage = await telegram.sendMessage(state.chatId, `Пользователь ${state.displayName} не согласился с правилами. Доступ к чату не выдан.`);
  scheduleDeleteMessage(telegram, state.chatId, rejectedMessage?.message_id);
}

function scheduleDeleteMessage(telegram, chatId, messageId, delay = 5000) {
  if (!telegram || !chatId || !messageId) {
    return;
  }
  setTimeout(async () => {
    try {
      await telegram.deleteMessage(chatId, messageId);
    } catch (deleteError) {
      // ignore deletion errors
    }
  }, delay);
}

function canSelfClearPunishmentHistory(ctx, targetUserId, actionName) {
  if (String(actionName || '').toLowerCase() !== 'clear_history') {
    return false;
  }

  const actorUserId = Number(ctx.from?.id);
  const targetId = Number(targetUserId);
  if (!Number.isFinite(actorUserId) || !Number.isFinite(targetId)) {
    return false;
  }

  return actorUserId === targetId;
}

function isGroupOwnerMember(member) {
  if (!member || typeof member !== 'object') {
    return false;
  }

  return String(member.status || '').toLowerCase() === 'creator';
}

function isGroupMemberWithProfileChangePermission(member) {
  if (!member || typeof member !== 'object') {
    return false;
  }

  const status = String(member.status || '').toLowerCase();
  if (status === 'creator') {
    return true;
  }

  if (status !== 'administrator') {
    return false;
  }

  if (member.can_change_info === undefined || member.can_change_info === null) {
    return true;
  }

  return Boolean(member.can_change_info);
}

function isGroupMemberWithManageRights(member) {
  if (!member || typeof member !== 'object') {
    return false;
  }

  const status = String(member.status || '').toLowerCase();
  if (status === 'creator') {
    return true;
  }

  if (status !== 'administrator') {
    return false;
  }

  const hasAnyManagePermission = Boolean(member.can_delete_messages || member.can_restrict_members || member.can_invite_users || member.can_manage_topics || member.can_pin_messages || member.can_manage_chat || member.can_manage_video_chats || member.can_promote_members || member.can_manage_events || member.can_change_info);

  if (hasAnyManagePermission) {
    return true;
  }

  return true;
}

async function canManageGroupSettings(ctx, targetChatId) {
  const userId = Number(ctx.from?.id);
  const chatId = Number(targetChatId);
  if (!Number.isFinite(userId) || !Number.isFinite(chatId)) {
    return false;
  }

  if (Number(ctx.chat?.owner_id) === userId) {
    return true;
  }

  try {
    const member = await ctx.telegram.getChatMember(chatId, userId);
    if (isGroupOwnerMember(member) || isGroupMemberWithProfileChangePermission(member)) {
      return true;
    }
  } catch (error) {
    // ignore and fall back to administrator list
  }

  try {
    const chat = await ctx.telegram.getChat(chatId);
    if (Number(chat?.owner_id) === userId) {
      return true;
    }
  } catch (error) {
    // ignore and continue
  }

  try {
    const administrators = await ctx.telegram.getChatAdministrators(chatId);
    const member = administrators.find((entry) => Number(entry.user?.id) === userId);
    return isGroupMemberWithProfileChangePermission(member);
  } catch (error) {
    return false;
  }
}

async function safeEditMessageText(ctx, text, extra) {
  try {
    await ctx.editMessageText(text, extra);
  } catch (err) {
    // Ignore "message is not modified" error - happens when content is identical to current message
    if (err.response?.description && !err.response.description.includes('message is not modified')) {
      throw err;
    }
  }
}

function getMessageLink(chatId, messageId) {
  const id = String(chatId || '');
  const msgId = Number(messageId) || 0;
  if (!id || !msgId) {
    return null;
  }
  if (id.startsWith('-100')) {
    return `https://t.me/c/${id.slice(4)}/${msgId}`;
  }
  return `https://t.me/${id}/${msgId}`;
}

function formatAdminReportText(report, acceptedBy = null) {
  const reporter = report.reporter;
  const target = report.target;
  const acceptedText = acceptedBy
    ? `\n\n✅ Жалобу принял модератор ${getMentionText(acceptedBy)} [${acceptedBy.id}]`
    : '';
  return [
    '⚠️ ВНИМАНИЕ!',
    `${getMentionText(reporter)} [${reporter.id}] требует действия администратора в группе:`,
    `"${report.groupTitle || getGroupDisplayName(report.chatId)}"`,
    '',
    `На кого: ${getMentionText(target.user)} [${target.user.id}]`,
    '',
    acceptedText,
  ].filter(Boolean).join('\n');
}

/**
 * Извлечь текст и entities из сообщения Telegram
 * @param {Object} ctx - Контекст Telegraf
 * @returns {Object} - { text: string, entities: Array }
 */
function buildTextPayloadFromMessage(ctx) {
  if (!ctx || !ctx.message) {
    return { text: '', entities: [] };
  }

  const text = ctx.message.text || ctx.message.caption || '';
  const entities = ctx.message.entities || ctx.message.caption_entities || [];

  return {
    text: String(text),
    entities: Array.isArray(entities) ? entities.filter(e => e && typeof e === 'object') : [],
  };
}

function buildAdminReportKeyboard(report) {
  const url = getMessageLink(report.chatId, report.target.messageId);
  return {
    inline_keyboard: [
      [{ text: 'Посмотреть сообщение', url: url || 'https://t.me' }],
      [{ text: 'Принять', callback_data: `admin_report:accept:${report.chatId}:${report.id}` }],
    ],
  };
}

function createAdminReportId() {
  return `r${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

function isAdminReportText(text) {
  return typeof text === 'string' && /(^|\s)@admin(\s|$)/i.test(text);
}

async function getManagedGroupsForUser(ctx) {
  const userId = Number(ctx.from?.id);
  if (!Number.isFinite(userId)) {
    return [];
  }

  const managedGroups = [];
  const seen = new Set();

  const addGroup = (chatId, title) => {
    const id = Number(chatId);
    if (!Number.isFinite(id) || seen.has(id)) {
      return;
    }
    seen.add(id);
    managedGroups.push({ chatId: id, title: title || String(id) });
  };

  if (ctx.chat?.id && ctx.chat?.type !== 'private') {
    try {
      const member = await ctx.telegram.getChatMember(ctx.chat.id, userId);
      if (isGroupMemberWithProfileChangePermission(member) || isGroupMemberWithManageRights(member)) {
        addGroup(ctx.chat.id, ctx.chat.title || String(ctx.chat.id));
      }
    } catch (error) {
      // ignore
    }
  }

  const groups = Object.values(activeDatabase?.data?.groups || {});
  for (const group of groups) {
    const chatId = Number(group.chatId);
    if (!Number.isFinite(chatId)) {
      continue;
    }

    try {
      const member = await ctx.telegram.getChatMember(chatId, userId);
      if (isGroupMemberWithProfileChangePermission(member) || isGroupMemberWithManageRights(member)) {
        addGroup(chatId, group.title || String(chatId));
      }
    } catch (error) {
      // ignore
    }
  }

  return managedGroups.sort((left, right) => String(left.title).localeCompare(String(right.title)));
}

async function showSettingsGroupSelector(ctx) {
  const managedGroups = await getManagedGroupsForUser(ctx);
  if (!managedGroups.length) {
    await ctx.reply('⚠️ У вас пока нет групп, где можно менять настройки бота.');
    return;
  }

  const keyboard = {
    inline_keyboard: [
      ...managedGroups.map((group) => [{ text: `🏘️ ${group.title}`, callback_data: `settings:select:${group.chatId}` }]),
      [{ text: '❌ Закрыть', callback_data: 'settings:close' }],
    ],
  };

  if (ctx.callbackQuery) {
    await ctx.editMessageText('🎛️ Выберите группу для настроек:', { reply_markup: keyboard });
  } else {
    await ctx.reply('🎛️ Выберите группу для настроек:', { reply_markup: keyboard });
  }
}

function buildSettingsMainKeyboard(chatId) {
  return [
    [
      { text: '🧩 Капча', callback_data: `settings:section:captcha:${chatId}` },
      { text: '🔗 Ссылки', callback_data: `settings:section:links:${chatId}` },
    ],
    [
      { text: '🛡️ Антиспам', callback_data: `settings:section:anti:${chatId}` },
      { text: '📜 Правила', callback_data: `settings:section:rules:${chatId}` },
    ],
    [
      { text: '🚫 Банворды', callback_data: `settings:section:banwords:${chatId}` },
      { text: '⚠️ Варны', callback_data: `settings:section:warns:${chatId}` },
    ],
    [
      { text: '⚙️ Команды', callback_data: `settings:section:commands:${chatId}` },
      { text: '🤖 Медиа ИИ', callback_data: `settings:section:media_ai:${chatId}` },
    ],
    [
      { text: '💬 Первый комментарий', callback_data: `settings:open_menu:${chatId}` },
      { text: '🚨 @admin', callback_data: `settings:section:admin:${chatId}` },
    ],
    [
      { text: premiumEmojis.getCustomEmojiFallback('series_premium') + ' Серия', callback_data: `settings:section:streaks:${chatId}` },
      { text: '😶‍🌫️ Скрытые пользователи', callback_data: `settings:section:anonymous:${chatId}` },
    ],
    [
      { text: '💬 Чат', callback_data: `settings:section:chat:${chatId}` },
      { text: '🔔 Упоминание', callback_data: `settings:section:mention:${chatId}` },
    ],
    [
      { text: '👥 Управление участниками', callback_data: `settings:section:members:${chatId}` },
      { text: '🤖 Бот Соо', callback_data: `menu:bot_message:${chatId}` },
    ],
  ];
}

function buildMenuKeyboard(chatId) {
  return {
    inline_keyboard: [
      [
        { text: 'Первое Соо', callback_data: 'menu:first_message' },
        { text: 'Текст сообщения', callback_data: 'menu:text' },
      ],
      [
        { text: 'Настройки кнопок', callback_data: 'menu:buttons' },
        { text: 'Добавить медиа', callback_data: 'menu:media' },
      ],
      [
        { text: 'Настройки команд', callback_data: 'menu:command_rights' },
        { text: 'Чат', callback_data: 'menu:chat' },
      ],
      [
        { text: 'Упоминание', callback_data: 'menu:mention' },
        { text: 'Управление Участниками', callback_data: 'menu:members' },
      ],
      [
        { text: '🤖 От Бота', callback_data: 'menu:bot_message' },
        { text: '🤖 Бот Соо', callback_data: 'menu:bot_message' },
      ],
    ],
  };
}

function buildSettingsChatKeyboard(chatId) {
  const service = activeModerationService || defaultModerationService;
  const mode = service.getChatAccessMode(chatId);
  const statusLabel = {
    open: 'Открыт',
    closed: 'Закрыт',
    admins: 'Только админы',
    owner: 'Только владелец',
  }[mode] || 'Открыт';

  return {
    inline_keyboard: [
      [
        { text: '🔒 Закрыть чат', callback_data: `settings:chat_access:${chatId}:closed` },
        { text: '📖 Открыть чат', callback_data: `settings:chat_access:${chatId}:open` },
      ],
      [
        { text: '👥 Только админы', callback_data: `settings:chat_access:${chatId}:admins` },
        { text: '👑 Только владелец', callback_data: `settings:chat_access:${chatId}:owner` },
      ],
      [{ text: `Статус: ${statusLabel}`, callback_data: `settings:section:chat:${chatId}` }],
      [{ text: 'Назад', callback_data: `settings:main:${chatId}` }],
    ],
  };
}

function buildMembersManagementKeyboard(chatId) {
  return {
    inline_keyboard: [
      [
        { text: 'Снять запрет всем', callback_data: `menu:members:unrestrict_all:${chatId}` },
        { text: 'Всех разблокировать', callback_data: `menu:members:unban_all:${chatId}` },
      ],
      [
        { text: 'Исключить ограниченных пользователей', callback_data: `menu:members:remove_restricted:${chatId}` },
      ],
      [
        { text: 'Исключить удалённые аккаунты', callback_data: `menu:members:remove_deleted:${chatId}` },
      ],
      [
        { text: 'Назад', callback_data: `settings:main:${chatId}` },
      ],
    ],
  };
}

function buildSettingsStreaksKeyboard(chatId) {
  const service = activeModerationService || defaultModerationService;
  const enabled = service.isStreaksEnabled(chatId);
  const label = service.getStreaksLabel(chatId);
  return {
    inline_keyboard: [
      [{ text: enabled ? 'Выключить серию' : 'Включить серию', callback_data: `settings:toggle_streaks:${chatId}:${enabled ? 'off' : 'on'}` }],
      [{ text: `Название: ${label}`, callback_data: `settings:streaks_label:${chatId}` }],
      [{ text: 'Назад', callback_data: `settings:main:${chatId}` }],
    ],
  };
}

function buildSettingsLinksKeyboard(chatId) {
  const enabled = (activeModerationService || defaultModerationService).isLinkProtectionEnabled(chatId);
  return {
    inline_keyboard: [
      [{ text: enabled ? 'Выключить антиссылки' : 'Включить антиссылки', callback_data: `settings:toggle_links:${chatId}:${enabled ? 'off' : 'on'}` }],
      [{ text: 'Добавить ссылку/домен', callback_data: `settings:add_link:${chatId}` }],
      [{ text: 'Убрать ссылку/домен', callback_data: `settings:remove_link:${chatId}` }],
      [{ text: 'Назад', callback_data: `settings:main:${chatId}` }],
    ],
  };
}

function buildSettingsAntiKeyboard(chatId) {
  const moderationService = activeModerationService || defaultModerationService;
  const spamEnabled = moderationService.isSpamProtectionEnabled(chatId);
  const floodEnabled = moderationService.isFloodProtectionEnabled(chatId);
  const linksEnabled = moderationService.isLinkProtectionEnabled(chatId);
  return {
    inline_keyboard: [
      [
        { text: spamEnabled ? 'Выключить антиспам' : 'Включить антиспам', callback_data: `settings:toggle_spam:${chatId}:${spamEnabled ? 'off' : 'on'}` },
        { text: floodEnabled ? 'Выключить антифлуд' : 'Включить антифлуд', callback_data: `settings:toggle_flood:${chatId}:${floodEnabled ? 'off' : 'on'}` },
      ],
      [
        { text: linksEnabled ? 'Выключить антиссылки' : 'Включить антиссылки', callback_data: `settings:toggle_links:${chatId}:${linksEnabled ? 'off' : 'on'}` },
      ],
      [
        { text: '📨 Пересылки', callback_data: `settings:forwards_menu:${chatId}` },
      ],
      [{ text: 'Назад', callback_data: `settings:main:${chatId}` }],
    ],
  };
}

function buildSettingsForwardsKeyboard(chatId) {
  return {
    inline_keyboard: [
      [
        { text: '🔗 Каналы', callback_data: `settings:forwards_category:${chatId}:channels` },
        { text: '👥 Группы', callback_data: `settings:forwards_category:${chatId}:groups` },
      ],
      [
        { text: '👤 Пользователи', callback_data: `settings:forwards_category:${chatId}:users` },
        { text: '🤖 Боты', callback_data: `settings:forwards_category:${chatId}:bots` },
      ],
      [
        { text: '➕ Добавить', callback_data: `settings:add_forward:${chatId}` },
        { text: '❌ Удалить', callback_data: `settings:remove_forward:${chatId}` },
      ],
      [{ text: 'Назад', callback_data: `settings:section:anti:${chatId}` }],
    ],
  };
}

function buildSettingsForwardsCategoryKeyboard(chatId, category) {
  return {
    inline_keyboard: [
      [{ text: '➕ Добавить в категорию', callback_data: `settings:add_forward_category:${chatId}:${category}` }],
      [{ text: '❌ Удалить из категории', callback_data: `settings:remove_forward_category:${chatId}:${category}` }],
      [{ text: '⚙️ Настройки', callback_data: `settings:forwards_settings:${chatId}:${category}` }],
      [{ text: 'Назад', callback_data: `settings:forwards_menu:${chatId}` }],
    ],
  };
}

function buildSettingsForwardsPunishmentKeyboard(chatId, category) {
  return {
    inline_keyboard: [
      [{ text: '🔴 Выкл', callback_data: `settings:set_forward_punishment:${chatId}:${category}:off` }],
      [{ text: '⚠️ Предупреждение', callback_data: `settings:set_forward_punishment:${chatId}:${category}:warn` }],
      [{ text: '🔇 Мут', callback_data: `settings:set_forward_punishment:${chatId}:${category}:mute` }],
      [{ text: '🚫 Кик', callback_data: `settings:set_forward_punishment:${chatId}:${category}:kick` }],
      [{ text: '🚫🚫 Бан', callback_data: `settings:set_forward_punishment:${chatId}:${category}:ban` }],
      [{ text: 'Назад', callback_data: `settings:forwards_settings:${chatId}:${category}` }],
    ],
  };
}

function buildSettingsForwardsDeleteMessageKeyboard(chatId, category, currentValue) {
  return {
    inline_keyboard: [
      [{ text: currentValue ? '✅ Да (удалять)' : '❌ Нет (не удалять)', callback_data: `settings:set_forward_delete:${chatId}:${category}:${!currentValue}` }],
      [{ text: 'Назад', callback_data: `settings:forwards_settings:${chatId}:${category}` }],
    ],
  };
}

function buildSettingsFirstMessageKeyboard(chatId) {
  const service = activeModerationService || defaultModerationService;
  const enabled = service.getMenuEnabled(chatId);
  return {
    inline_keyboard: [
      [{ text: enabled ? 'Отключить первый комментарий' : 'Включить первый комментарий', callback_data: `settings:first_toggle:${chatId}` }],
      [{ text: 'Изменить текст', callback_data: `settings:first_text:${chatId}` }],
      [{ text: 'Настройки кнопок', callback_data: `settings:first_buttons:${chatId}` }],
      [{ text: 'Добавить медиа', callback_data: `settings:first_media:${chatId}` }],
      [{ text: 'Удалить медиа', callback_data: `settings:first_remove_media:${chatId}` }],
      [{ text: 'Назад', callback_data: `settings:main:${chatId}` }],
    ],
  };
}

function buildSettingsFirstMessageButtonsKeyboard(chatId) {
  const service = activeModerationService || defaultModerationService;
  const rowsData = service.getMenuButtons(chatId);
  const rows = [];

  rowsData.forEach((row, rowIndex) => {
    const rowLabel = row.length ? row.map((item) => item.text).join(', ') : 'пусто';
    rows.push([
      { text: `Ряд ${rowIndex + 1}: ${rowLabel}`, callback_data: `settings:first_button_row:${chatId}:${rowIndex}` },
    ]);
    rows.push([
      { text: 'Добавить кнопку', callback_data: `settings:first_button_add:${chatId}:${rowIndex}` },
      { text: 'Удалить ряд', callback_data: `settings:first_button_remove_row:${chatId}:${rowIndex}` },
    ]);
  });

  rows.push([
    { text: 'Добавить ряд', callback_data: `settings:first_button_add_row:${chatId}` },
    { text: 'Удалить кнопку', callback_data: `settings:first_button_remove_last:${chatId}` },
  ]);
  rows.push([{ text: 'Назад', callback_data: `settings:open_menu:${chatId}` }]);

  return { inline_keyboard: rows };
}

function buildSettingsRulesKeyboard(chatId) {
  const service = activeModerationService || defaultModerationService;
  const enabled = service.isRulesEnabled(chatId);
  return {
    inline_keyboard: [
      [{ text: enabled ? 'Отключить правила' : 'Включить правила', callback_data: `settings:rules_toggle:${chatId}` }],
      [{ text: 'Изменить правила', callback_data: `settings:rules_edit:${chatId}` }],
      [{ text: 'Добавить правила', callback_data: `settings:rules_add:${chatId}` }],
      [{ text: 'Удалить правила', callback_data: `settings:rules_clear:${chatId}` }],
      [{ text: 'Назад', callback_data: `settings:main:${chatId}` }],
    ],
  };
}

function buildSettingsRulesMenuText(chatId, rulesText = '') {
  const rules = String(rulesText || '').trim();
  return [
    '📜 Настройки правил группы',
    '',
    'Текущие правила:',
    rules || 'Пока не заданы.',
    '',
    'Выберите действие:',
  ].join('\n');
}

function buildSettingsBanwordsKeyboard(chatId) {
  const service = activeModerationService || defaultModerationService;
  const mode = service.getBanwordPunishmentMode(chatId);
  const deleteMessages = service.getBanwordDeleteMessages(chatId);

  return {
    inline_keyboard: [
      [
        { text: mode === 'off' ? '✅ Выкл' : 'Выкл', callback_data: `settings:banword_mode:${chatId}:off` },
        { text: mode === 'warn' ? '✅ Варн' : 'Варн', callback_data: `settings:banword_mode:${chatId}:warn` },
        { text: mode === 'ban' ? '✅ Забанить' : 'Забанить', callback_data: `settings:banword_mode:${chatId}:ban` },
      ],
      [
        { text: mode === 'mute' ? '✅ Замутить' : 'Замутить', callback_data: `settings:banword_mode:${chatId}:mute` },
      ],
      [{ text: `Удалять сообщения ${deleteMessages ? '✔️' : '❌'}`, callback_data: `settings:banword_delete:${chatId}` }],
      [
        { text: 'Добавить', callback_data: `settings:banword_add:${chatId}` },
        { text: 'Удалить', callback_data: `settings:banword_remove:${chatId}` },
      ],
      [{ text: 'Список', callback_data: `settings:banword_list:${chatId}` }],
      [{ text: 'Назад', callback_data: `settings:main:${chatId}` }],
    ],
  };
}

function buildSettingsAdminKeyboard(chatId) {
  const service = activeModerationService || defaultModerationService;
  const mode = service.getAdminNotifyMode(chatId);
  const notifyOwner = service.getAdminNotifyOwner(chatId);
  const notifyAdmins = service.getAdminNotifyAdmins(chatId);
  const advanced = service.getAdminNotifyAdvanced(chatId);

  return {
    inline_keyboard: [
      [
        { text: `Никто${mode === 'none' ? ' ✅' : ''}`, callback_data: `settings:admin_notify:none:${chatId}` },
        { text: `👑 Владелец${mode === 'owner' ? ' ✅' : ''}`, callback_data: `settings:admin_notify:owner:${chatId}` },
      ],
      [
        { text: `👥 Группа персонала${mode === 'staff' ? ' ✅' : ''}`, callback_data: `settings:admin_notify:staff:${chatId}` },
      ],
      [
        { text: `🔔 Уведомить Владелец ${notifyOwner ? '✅' : '❌'}`, callback_data: `settings:admin_notify:notify_owner:${chatId}` },
      ],
      [
        { text: `🔔 Уведомить Администраторов ${notifyAdmins ? '✅' : '❌'}`, callback_data: `settings:admin_notify:notify_admins:${chatId}` },
      ],
      [
        { text: `🛠️ Расширенные настройки${advanced ? ' ✅' : ''}`, callback_data: `settings:admin_notify_advanced:${chatId}` },
      ],
      [{ text: 'Назад', callback_data: `settings:main:${chatId}` }],
    ],
  };
}

function buildSettingsAdminAdvancedKeyboard(chatId) {
  const service = activeModerationService || defaultModerationService;
  const onlyInReply = service.getAdminNotifyOnlyInReply(chatId);
  const reasonRequired = service.getAdminNotifyReasonRequired(chatId);
  const deleteOnProcess = service.getAdminNotifyDeleteOnProcess(chatId);
  const deleteInStaff = service.getAdminNotifyDeleteInStaffGroup(chatId);

  return {
    inline_keyboard: [
      [{ text: `Только в ответ: ${onlyInReply ? '✅' : '❌'}`, callback_data: `settings:admin_notify:toggle_only_in_reply:${chatId}` }],
      [{ text: `Причина обязательна: ${reasonRequired ? '✅' : '❌'}`, callback_data: `settings:admin_notify:toggle_reason_required:${chatId}` }],
      [{ text: `Удалять при обработке отчёта: ${deleteOnProcess ? '✅' : '❌'}`, callback_data: `settings:admin_notify:toggle_delete_on_process:${chatId}` }],
      [{ text: `Удалять в группе персонала при обработке отчёта: ${deleteInStaff ? '✅' : '❌'}`, callback_data: `settings:admin_notify:toggle_delete_in_staff:${chatId}` }],
      [{ text: 'Назад', callback_data: `settings:admin_notify:${chatId}` }],
    ],
  };
}

function buildSettingsAdminAdvancedMenuText() {
  return [
    '🚨 Расширенные настройки @admin',
    '',
    'Описание опций:',
    '',
    '🧾 Только в ответ: Команда @admin доступна только при ответе на сообщение нарушителя.',
    '',
    '✍️ Причина обязательна: Пользователь должен указать причину в тексте отчёта.',
    '',
    '🗑️ Удалять при обработке отчёта: Сообщение отчёта и сообщение пользователя удаляются после пометки отчёта как обработанного.',
    '',
    '🔒 Удалять в группе персонала при обработке отчёта: Если включено, сообщение отчёта будет также удалено из группы персонала при обработке.',
  ].join('\n');
}

function getHelpPages() {
  return [
    [
      '📋 СПРАВКА ПО КОМАНДАМ',
      '',
      '👤 ПОЛЬЗОВАТЕЛЬСКИЕ КОМАНДЫ',
      '/start, !начало - начать работу',
      '/help, !помощь - показать эту справку',
      '/id, !айди - показать ваши ID',
      '/about, !информация - информация о боте',
      '/whoami, !кто я - забавное описание вас',
      '/stats, !статистика - личная статистика пользователя',
      '/top, !топ - топ пользователей по сообщениям в группе',
    ].join('\n'),
    [
      '📋 СПРАВКА ПО КОМАНДАМ',
      '',
      '👮 МОДЕРСКИЕ КОМАНДЫ',
      '/rules, !правила - показать правила чата',
      '/setrules, !установить правила <текст> - установить правила',
      '/setgreeting, !установить приветствие <текст> - установить приветствие',
      '+антиспам - включить антиспам',
      '-антиспам - выключить антиспам',
      '+антифлуд - включить антифлуд',
      '-антифлуд - выключить антифлуд',
      '+ссылки - включить антиссылки',
      '-ссылки - выключить антиссылки',
      '/menu - открыть настройки первого сообщения бота',
      '/menu + текст - настроить текст сообщения',
      '/menu + кнопки - настроить кнопки и ряды',
      '/menu + медиа - добавить фото/видео/документ в сообщение',
      '/warn, !предупреждение @юз - выдать предупреждение',
      '/delwarn, !delwarn <причина> - выдать предупреждение и удалить сообщение (только ответом)',
      '/warnings, !варны [@юз] - показать варны пользователя',
      '/unwarn, !снять предупреждение @юз - снять предупреждения',
      '/mute, !мут @юз <время> <причина> - ограничить сообщения',
      '/delmute, !delmute <время> <причина> - выдать mute и удалить сообщение (только ответом)',
      '/unmute, !размут - снять ограничение',
      '/ban, !бан <время> <причина> - заблокировать пользователя',
      '/delban, !delban <время> <причина> - заблокировать и удалить сообщение (только ответом)',
      '/unban, !разбан - разблокировать пользователя',
      '/banlist, !баны [страница] - список активных банов',
      '/mutelist, !муты [страница] - список активных мутов',
      '/admins, !админы - список администраторов бота',
      '/addadmin @юз, !добавить админа @юз - назначить админа бота',
      '/removeadmin @юз, !снять админа @юз - снять вспомогательного администратора бота',
      '/promote @юз [уровень], !повышение @юз [уровень] - повысить администратора (если уровень не указан, повышает на 1)',
      '/demote @юз [уровень], !разжалование @юз [уровень] - понизить администратора (если уровень не указан, понижает на 1)',
      '',
      '🛡️ КОМАНДЫ НАКАЗАНИЙ',
      '/admincom - список команд наказаний и примеры их использования',
    ].join('\n'),
    [
      '📋 Админ-система бота',
      '',
      'Админ-система бота управляет правами и доступом в группе. Все права привязаны к ролям и уровню администрирования.',
      '',
      'Уровни (1 = наивысший):',
      '1 — Главный админ (владелец группы). Это главный админ и он всегда имеет приоритет выше всех.',
      '2 — Ведущий админ. Доступ ко всем командам модерации и приоритет выше остальных администраторов.',
      '3 — Старший админ. Может мутить и выдавать предупреждения, а также банить, но имеет более высокий приоритет, чем средний и младший админ.',
      '4 — Средний админ. Может мутить, выдавать предупреждения и банить.',
      '5 — Младший админ. Может только мутить и выдавать предупреждения.',
      '',
      'Команды управления админ-правами:',
      '/admins — показать список администраторов бота и их уровни',
      '/addadmin @user [уровень] — назначить админ-роль бота',
      '/removeadmin @user — снять админ-роль бота',
      '/promote @user [уровень] — повысить админа на один уровень или до указанного',
      '/demote @user [уровень] — понизить админа на один уровень или до указанного',
      '',
      'Важно:',
      '- Нельзя наказывать админов выше себя. При попытке выводится предупреждение: "Ты не можешь наказывать админов выше себя".',
      '- Владелец группы всегда остаётся главным админом и не может быть снят другими администраторами.',
      '- Доступ к /menu дан только администраторам группы, у которых есть право "Изменить профиль группы".',
      '',
      'Примеры:',
      '/addadmin @ivan 4 — назначить @ivan админом уровня 4',
      '/promote @petya — повысить @petya на один уровень',
    ].join('\n'),
    [
      '📋 СПРАВКА ПО КОМАНДАМ',
      '',
      '🎉 РАЗВЛЕЧЕНИЯ',
      '/hug @юз, !обнять @юз - обнять пользователя',
      '/kiss @юз, !поцеловать @юз - поцеловать пользователя',
      '/slap @юз, !шлёпнуть @юз - шлёпнуть пользователя',
      '/poke @юз, !тыкнуть @юз - ткнуть пользователя',
      '/coin, !монетка - подбросить монетку',
      '/dice, !кубик - бросить кубик',
      '/fate, !вопрос - спросить судьбу',
      '/compliment, !комплимент - получить комплимент',
      '/insult, !инсульт - получить приятную шутку',
      '/ai <текст> - спросить AI и получить ответ',
      '',
      'Используйте русские команды с ! и английские с /',
    ].join('\n'),
  ];
}

function buildSettingsCommandRightsText(chatId, pageIndex = 0) {
  const pages = getHelpPages();
  const selectedPage = Math.max(0, Math.min(pageIndex, pages.length - 1));
  return `${pages[selectedPage]}

Страница ${selectedPage + 1}/${pages.length}`;
}

function buildSettingsCommandRightsKeyboard(chatId, pageIndex = 0) {
  const pages = getHelpPages();
  const selectedPage = Math.max(0, Math.min(pageIndex, pages.length - 1));
  const buttons = [];
  if (selectedPage > 0) {
    buttons.push({ text: '⬅️ Назад', callback_data: `settings:command_rights:${chatId}:${selectedPage - 1}` });
  }
  if (selectedPage < pages.length - 1) {
    buttons.push({ text: 'Вперёд ➡️', callback_data: `settings:command_rights:${chatId}:${selectedPage + 1}` });
  }

  return {
    inline_keyboard: [
      buttons,
      [{ text: 'Назад', callback_data: `settings:main:${chatId}` }],
    ],
  };
}

async function showSettingsCommandRightsMenu(ctx, chatId, pageIndex = 0) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  await ctx.editMessageText(buildSettingsCommandRightsText(chatId, pageIndex), {
    reply_markup: buildSettingsCommandRightsKeyboard(chatId, pageIndex),
  });
}

async function showSettingsAdminAdvancedMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  await ctx.editMessageText(buildSettingsAdminAdvancedMenuText(), { reply_markup: buildSettingsAdminAdvancedKeyboard(chatId) });
}

function buildSettingsAdminMenuText() {
  return [
    '🚨 @admin — это команда, доступная пользователям для привлечения внимания персонала группы, например, в случае, если какой-либо другой пользователь не соблюдает правила группы.',
    '',
    'В этом меню вы можете указать, куда вы хотите, чтобы отчеты, сделанные пользователями, отправлялись, и/или нужно ли помечать некоторый персонал напрямую.',
    '',
    '⚠️ Команда @admin НЕ работает, если используется администратором с разрешением "Блокировка пользователей", или модератором.',
    '',
    'Уведомление получит:',
  ].join('\n');
}

function buildSettingsAnonymousMenuText() {
  return [
    '😶‍🌫️ Скрытые пользователи',
    '',
    'Через это меню вы можете установить наказание для пользователей, которые пишут в группу, маскируясь под канал.',
    '',
    'Telegram позволяет каждому пользователю писать в группу, скрывая своё сообщение.',
    '',
    'Это позволит модератору правильно определить, что пишет это сообщение и является ли он администратором: эта блокировка будет применяться ко всем, кто пишет через канал.',
    '',
    'Если этот параметр включен, пользователь, пишущий в группу через канал, будет способен отправлять сообщения, которые удаляются автоматически в зависимости от настроек.',
  ].join('\n');
}

function buildSettingsAnonymousKeyboard(chatId) {
  const service = activeModerationService || defaultModerationService;
  const enabled = service.isHideAnonymousEnabled(chatId);
  const deleteMessages = service.shouldDeleteAnonymousMessages(chatId);

  return {
    inline_keyboard: [
      [
        { text: 'Исключения', callback_data: `settings:anonymous_exceptions:${chatId}` },
      ],
      [
        { text: enabled ? '✅ Включено' : '❌ Отключено', callback_data: `settings:toggle_anonymous:${chatId}` },
      ],
      [
        { text: `Удалять сообщения: ${deleteMessages ? '✅' : '❌'}`, callback_data: `settings:toggle_delete_anonymous:${chatId}` },
      ],
      [{ text: 'Назад', callback_data: `settings:main:${chatId}` }],
    ],
  };
}

function buildSettingsAnonymousExceptionsText(chatId) {
  const service = activeModerationService || defaultModerationService;
  const allowedChannels = service.getAllowedAnonymousChannels(chatId);
  const lines = [
    '🚫 Исключения каналов',
    '',
    'Здесь можно добавить каналы, сообщения от которых будут приниматься как разрешённые канал-посты и не удаляться.',
    '',
    'Введите @username, t.me/username или numeric ID канала для добавления.',
    '',
    'Текущие исключения:',
  ];
  if (allowedChannels.length === 0) {
    lines.push('— пока нет');
  } else {
    allowedChannels.forEach((channelId) => {
      lines.push(`• ${channelId}`);
    });
  }
  return lines.join('\n');
}

function buildSettingsAnonymousExceptionsKeyboard(chatId) {
  return {
    inline_keyboard: [
      [{ text: 'Добавить канал', callback_data: `settings:anonymous_add_channel:${chatId}` }],
      [{ text: 'Удалить канал', callback_data: `settings:anonymous_remove_channel:${chatId}` }],
      [{ text: 'Назад', callback_data: `settings:section:anonymous:${chatId}` }],
    ],
  };
}

async function showSettingsAnonymousMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  await safeEditMessageText(ctx, buildSettingsAnonymousMenuText(), { reply_markup: buildSettingsAnonymousKeyboard(chatId) });
}

async function showSettingsAnonymousExceptionsMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  await safeEditMessageText(ctx, buildSettingsAnonymousExceptionsText(chatId), { reply_markup: buildSettingsAnonymousExceptionsKeyboard(chatId) });
}

async function safeEditMessageText(ctx, text, extra = {}) {
  try {
    await ctx.editMessageText(text, extra);
  } catch (error) {
    const description = error?.response?.description || error?.description || '';
    const retryAfter = Number(error?.response?.parameters?.retry_after ?? error?.parameters?.retry_after ?? error?.retry_after ?? 0);

    if (typeof description === 'string' && description.includes('message is not modified')) {
      return;
    }

    if (retryAfter > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      try {
        await ctx.editMessageText(text, extra);
        return;
      } catch (retryError) {
        const retryDescription = retryError?.response?.description || retryError?.description || '';
        if (typeof retryDescription === 'string' && retryDescription.includes('message is not modified')) {
          return;
        }
      }
    }

    throw error;
  }
}

function buildSettingsMediaAiText(chatId) {
  const service = activeModerationService || defaultModerationService;
  const enabled = service.isMediaAiEnabled(chatId);
  const apiKeyConfigured = Boolean(activeConfig?.aiApiKey);
  return [
    '🤖 Медиа ИИ',
    '',
    '🛡️ При включении ИИ будет проверять медиа в чате на контент 18+.',
    '🚫 Если файл считается запрещённым, сообщение будет удалено, а отправитель получит блокировку.',
    '',
    `📌 Статус: ${enabled ? '✅ Включено' : '❌ Отключено'}`,
    `🔑 AI-ключ: ${apiKeyConfigured ? 'настроен' : 'не найден'}`,
    '',
    apiKeyConfigured ? '👉 Нажмите кнопку ниже, чтобы включить или отключить защиту.' : '⚠️ Чтобы функция работала, добавьте OPENROUTER_API_KEY или AI_API_KEY в .env.',
  ].join('\n');
}

function buildSettingsMediaAiKeyboard(chatId) {
  const service = activeModerationService || defaultModerationService;
  const enabled = service.isMediaAiEnabled(chatId);
  return {
    inline_keyboard: [
      [{ text: enabled ? 'Выключить Медиа ИИ' : 'Включить Медиа ИИ', callback_data: `settings:toggle_media_ai:${chatId}:${enabled ? 'off' : 'on'}` }],
      [{ text: 'Назад', callback_data: `settings:main:${chatId}` }],
    ],
  };
}

async function showSettingsMediaAiMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  await safeEditMessageText(ctx, buildSettingsMediaAiText(chatId), { reply_markup: buildSettingsMediaAiKeyboard(chatId) });
}

async function showSettingsAdminMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  await safeEditMessageText(ctx, buildSettingsAdminMenuText(), { reply_markup: buildSettingsAdminKeyboard(chatId) });
}

async function showSettingsMainMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('⚠️ У вас нет прав менять настройки этой группы.');
    return;
  }

  const title = getGroupDisplayName(chatId, String(chatId));
  const text = `⚙️ Панель управления группой\n\n🏘️ ${title}\n\nВыберите раздел настроек ниже:`;
  const replyMarkup = { inline_keyboard: buildSettingsMainKeyboard(chatId) };
  if (ctx.callbackQuery) {
    await safeEditMessageText(ctx, text, { reply_markup: replyMarkup });
  } else {
    await ctx.reply(text, { reply_markup: replyMarkup });
  }
}

async function showSettingsChatMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  const service = activeModerationService || defaultModerationService;
  const mode = service.getChatAccessMode(chatId);
  const labels = {
    open: '📖 Открыт — все могут писать',
    closed: '🔒 Закрыт — писать нельзя',
    admins: '👥 Только администраторы могут писать',
    owner: '👑 Только владелец группы может писать',
  };

  const text = [
    '💬 Настройки чата',
    '',
    `Текущий режим: ${labels[mode] || labels.open}`,
    '',
    '• Открыть чат — все могут писать',
    '• Закрыть чат — никто не может писать, даже администраторы',
    '• Только админы — писать могут администраторы и владелец',
    '• Только владелец — писать может только владелец группы',
  ].join('\n');

  await safeEditMessageText(ctx, text, { reply_markup: buildSettingsChatKeyboard(chatId) });
}

function buildSettingsCaptchaKeyboard(chatId) {
  const moderationService = activeModerationService || defaultModerationService;
  const enabled = moderationService.isCaptchaEnabled(chatId);
  const mode = moderationService.getCaptchaMode(chatId);
  const timeout = moderationService.getCaptchaTimeoutMinutes(chatId);
  return {
    inline_keyboard: [
      [{ text: enabled ? 'Отключить капчу' : 'Включить капчу', callback_data: `settings:toggle_captcha:${chatId}:${enabled ? 'off' : 'on'}` }],
      [{ text: 'Режимы', callback_data: `settings:captcha_modes:${chatId}` }],
      [{ text: `Время: ${timeout} мин`, callback_data: `settings:captcha_timeout:${chatId}` }],
      [{ text: '📜 Соглашение', callback_data: `settings:agreement:${chatId}` }],
      [{ text: 'Назад', callback_data: `settings:main:${chatId}` }],
    ],
  };
}

function buildSettingsAgreementKeyboard(chatId) {
  const moderationService = activeModerationService || defaultModerationService;
  const enabled = moderationService.isAgreementEnabled(chatId);
  return {
    inline_keyboard: [
      [{ text: enabled ? 'Отключить соглашение' : 'Включить соглашение', callback_data: `settings:toggle_agreement:${chatId}:${enabled ? 'off' : 'on'}` }],
      [{ text: 'Редактировать текст', callback_data: `settings:agreement_edit:${chatId}` }],
      [{ text: 'Добавить медиа', callback_data: `settings:agreement_media:${chatId}` }],
      [{ text: 'Удалить медиа', callback_data: `settings:agreement_remove_media:${chatId}` }],
      [{ text: 'Назад', callback_data: `settings:section:captcha:${chatId}` }],
    ],
  };
}

function buildCaptchaModesKeyboard(chatId) {
  const moderationService = activeModerationService || defaultModerationService;
  const currentMode = moderationService.getCaptchaMode(chatId);
  const modes = [
    { key: 'emoji', label: 'Эмоджи' },
    { key: 'math', label: 'Пример' },
    { key: 'color', label: 'Цвет' },
    { key: 'word', label: 'Слово' },
  ];
  return {
    inline_keyboard: [
      ...modes.map((mode) => [{ text: `${mode.label}${currentMode === mode.key ? ' ✅' : ''}`, callback_data: `settings:captcha_mode:${chatId}:${mode.key}` }]),
      [{ text: 'Назад', callback_data: `settings:section:captcha:${chatId}` }],
    ],
  };
}

function buildCaptchaTimeoutKeyboard(chatId) {
  const moderationService = activeModerationService || defaultModerationService;
  const current = moderationService.getCaptchaTimeoutMinutes(chatId);
  const options = [1, 2, 3, 5, 10, 15, 20, 30];
  return {
    inline_keyboard: [
      ...options.map((minutes) => [{ text: `${minutes} мин${current === minutes ? ' ✅' : ''}`, callback_data: `settings:captcha_timeout_set:${chatId}:${minutes}` }]),
      [{ text: 'Назад', callback_data: `settings:section:captcha:${chatId}` }],
    ],
  };
}

async function showSettingsCaptchaMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  const moderationService = activeModerationService || defaultModerationService;
  const enabled = moderationService.isCaptchaEnabled(chatId);
  const mode = moderationService.getCaptchaMode(chatId);
  const timeout = moderationService.getCaptchaTimeoutMinutes(chatId);
  const text = [
    '🧠 Капча',
    '',
    'При активации капчи, когда пользователь входит в группу он не сможет отправлять сообщения, пока не подтвердит, что он не робот.',
    '',
    '🕑 Вы также можете принять решение о наказании ниже для тех, кто не решит капчу в течение отведённого времени и следует ли удалять системное сообщение в случае неудачи.',
    '',
    `🔐 Статус: ${enabled ? 'включена' : 'отключена'}`,
    `🗂 Режим: ${mode === 'math' ? 'Пример' : mode === 'color' ? 'Цвет' : mode === 'word' ? 'Слово' : 'Эмоджи'}`,
    `⏱ Время прохождения: ${timeout} мин`,
  ].join('\n');

  await ctx.editMessageText(text, { reply_markup: buildSettingsCaptchaKeyboard(chatId) });
}

async function showSettingsAgreementMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  const moderationService = activeModerationService || defaultModerationService;
  const enabled = moderationService.isAgreementEnabled(chatId);
  const agreementText = moderationService.getAgreementText(chatId) || 'Правила ещё не заданы.';
  const media = moderationService.getAgreementMedia(chatId);
  const text = [
    '📜 Пользовательское соглашение',
    '',
    `Статус: ${enabled ? 'включено' : 'выключено'}`,
    `Медиа: ${media ? media.type : 'не добавлено'}`,
    '',
    'Текст соглашения:',
    agreementText.slice(0, 900) || 'Пусто',
  ].join('\n');

  await ctx.editMessageText(text, { reply_markup: buildSettingsAgreementKeyboard(chatId) });
}

async function showSettingsLinksMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  const moderationService = activeModerationService || defaultModerationService;
  const enabled = moderationService.isLinkProtectionEnabled(chatId);
  const links = moderationService.getAllowedLinks(chatId);
  const text = [
    '🔗 Настройки антиссылок',
    '',
    enabled ? '✅ Антиссылки включены' : '⚪ Антиссылки выключены',
    `📋 Разрешённых ссылок/доменов: ${links.length}`,
    links.length ? `• ${links.join('\n• ')}` : 'Список разрешённых ссылок пуст.',
  ].join('\n');

  await ctx.editMessageText(text, { reply_markup: buildSettingsLinksKeyboard(chatId) });
}

async function showSettingsForwardsMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  const moderationService = activeModerationService || defaultModerationService;
  const forwards = moderationService.getAllowedForwards(chatId);
  const text = [
    '📨 Настройки пересылок',
    '',
    'Управление исключениями для пересылок в группу.',
    'Здесь вы можете разрешить пересылки от конкретных пользователей, каналов или групп.',
    '',
    `✅ Разрешённые источники пересылок: ${forwards.length}`,
    forwards.length ? `• ${forwards.join('\n• ')}` : 'Список исключений пуст.',
  ].join('\n');

  try {
    await ctx.editMessageText(text, { reply_markup: buildSettingsForwardsKeyboard(chatId) });
  } catch (error) {
    if (error.description && error.description.includes('message is not modified')) {
      await safeAnswerCbQuery(ctx, '🔜 Меню уже открыто');
    } else {
      throw error;
    }
  }
}

async function showSettingsForwardsCategoryMenu(ctx, chatId, category) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  const moderationService = activeModerationService || defaultModerationService;
  const forwards = moderationService.getAllowedForwards(chatId);
  
  const categoryLabels = {
    channels: '🔗 Каналы',
    groups: '👥 Группы',
    users: '👤 Пользователи',
    bots: '🤖 Боты',
  };

  const categoryDescriptions = {
    channels: 'Разрешённые каналы для пересылок',
    groups: 'Разрешённые группы для пересылок',
    users: 'Разрешённые пользователи для пересылок',
    bots: 'Разрешённые боты для пересылок',
  };

  const text = [
    categoryLabels[category] || 'Категория',
    '',
    categoryDescriptions[category] || '',
    `Всего разрешённых источников: ${forwards.length}`,
    forwards.length ? `• ${forwards.join('\n• ')}` : 'Список исключений пуст.',
  ].join('\n');

  try {
    await ctx.editMessageText(text, { reply_markup: buildSettingsForwardsCategoryKeyboard(chatId, category) });
  } catch (error) {
    if (error.description && error.description.includes('message is not modified')) {
      await safeAnswerCbQuery(ctx, '🔜 Меню уже открыто');
    } else {
      throw error;
    }
  }
}

async function showSettingsForwardsSettingsMenu(ctx, chatId, category) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  const moderationService = activeModerationService || defaultModerationService;
  const settings = moderationService.getForwardsSettings(chatId, category);
  
  const categoryLabels = {
    channels: '🔗 Каналы',
    groups: '👥 Группы',
    users: '👤 Пользователи',
    bots: '🤖 Боты',
  };

  const punishmentLabels = {
    off: '🔴 Выкл (только удалить)',
    warn: '⚠️ Предупреждение',
    mute: '🔇 Мут',
    kick: '🚫 Кик',
    ban: '🚫🚫 Бан',
  };

  const text = [
    `⚙️ Настройки ${categoryLabels[category] || 'категории'}`,
    '',
    `Наказание: ${punishmentLabels[settings.punishmentMode] || settings.punishmentMode}`,
    `Удалять сообщения: ${settings.deleteMessage ? '✅ Да' : '❌ Нет'}`,
  ].join('\n');

  const keyboard = {
    inline_keyboard: [
      [{ text: '⚠️ Наказание', callback_data: `settings:forwards_punishment:${chatId}:${category}` }],
      [{ text: settings.deleteMessage ? '✅ Удалять сообщения' : '❌ Не удалять сообщения', callback_data: `settings:forwards_delete:${chatId}:${category}` }],
      [{ text: 'Назад', callback_data: `settings:forwards_category:${chatId}:${category}` }],
    ],
  };

  try {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  } catch (error) {
    if (error.description && error.description.includes('message is not modified')) {
      await safeAnswerCbQuery(ctx, '🔜 Меню уже открыто');
    } else {
      throw error;
    }
  }
}

async function showSettingsForwardsPunishmentMenu(ctx, chatId, category) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  const moderationService = activeModerationService || defaultModerationService;
  const settings = moderationService.getForwardsSettings(chatId, category);
  
  const categoryLabels = {
    channels: '🔗 Каналы',
    groups: '👥 Группы',
    users: '👤 Пользователи',
    bots: '🤖 Боты',
  };

  const punishmentLabels = {
    off: '🔴 Выкл (только удалить)',
    warn: '⚠️ Предупреждение',
    mute: '🔇 Мут',
    kick: '🚫 Кик',
    ban: '🚫🚫 Бан',
  };

  const text = [
    `Выберите наказание для ${categoryLabels[category] || 'категории'}:`,
    '',
    `Текущее: ${punishmentLabels[settings.punishmentMode] || settings.punishmentMode}`,
  ].join('\n');

  try {
    await ctx.editMessageText(text, { reply_markup: buildSettingsForwardsPunishmentKeyboard(chatId, category) });
  } catch (error) {
    if (error.description && error.description.includes('message is not modified')) {
      await safeAnswerCbQuery(ctx, '🔜 Меню уже открыто');
    } else {
      throw error;
    }
  }
}

async function showSettingsForwardsDeleteMessageMenu(ctx, chatId, category) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  const moderationService = activeModerationService || defaultModerationService;
  const settings = moderationService.getForwardsSettings(chatId, category);
  
  const categoryLabels = {
    channels: '🔗 Каналы',
    groups: '👥 Группы',
    users: '👤 Пользователи',
    bots: '🤖 Боты',
  };

  const text = [
    `Удалять пересылки от ${categoryLabels[category] || 'категории'}?`,
    '',
    `Текущее: ${settings.deleteMessage ? '✅ Да' : '❌ Нет'}`,
  ].join('\n');

  try {
    await ctx.editMessageText(text, { reply_markup: buildSettingsForwardsDeleteMessageKeyboard(chatId, category, settings.deleteMessage) });
  } catch (error) {
    if (error.description && error.description.includes('message is not modified')) {
      await safeAnswerCbQuery(ctx, '🔜 Меню уже открыто');
    } else {
      throw error;
    }
  }
}

async function showSettingsAntiMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  const moderationService = activeModerationService || defaultModerationService;
  const spamEnabled = moderationService.isSpamProtectionEnabled(chatId);
  const floodEnabled = moderationService.isFloodProtectionEnabled(chatId);
  const linksEnabled = moderationService.isLinkProtectionEnabled(chatId);
  const text = [
    '🛡️ Настройки анти-модерации',
    '',
    `Антиспам: ${spamEnabled ? 'включён' : 'выключен'}`,
    `Антифлуд: ${floodEnabled ? 'включён' : 'выключен'}`,
    `Антиссылки: ${linksEnabled ? 'включены' : 'выключены'}`,
  ].join('\n');

  await ctx.editMessageText(text, { reply_markup: buildSettingsAntiKeyboard(chatId) });
}

async function showSettingsStreaksMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  const service = activeModerationService || defaultModerationService;
  const enabled = service.isStreaksEnabled(chatId);
  const label = service.getStreaksLabel(chatId);
  const text = [
    '🔥 Настройка системы серий',
    '',
    `Статус: ${enabled ? 'включена' : 'отключена'}`,
    `Название: ${label}`,
    '',
    '• можно включить или выключить систему',
    '• можно заменить название раздела: Серия, Стрик, Рейтинг, Стаж',
    '• система учитывает ежедневную активность и отображается в /stats и /top',
  ].join('\n');

  const entities = [];
  const seriesEmojiInfo = premiumEmojis.getCustomEmojiInfo('series_premium');
  if (seriesEmojiInfo && seriesEmojiInfo.id) {
    entities.push({
      type: 'custom_emoji',
      offset: 0,
      length: seriesEmojiInfo.fallback.length,
      custom_emoji_id: seriesEmojiInfo.id,
    });
  }

  await ctx.editMessageText(text, { reply_markup: buildSettingsStreaksKeyboard(chatId), entities: entities.length ? entities : undefined });
}

async function showSettingsFirstMessageMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  const service = activeModerationService || defaultModerationService;
  const text = [
    '📣 Настройка первого сообщения',
    '',
    `🔘 Состояние: ${service.getMenuEnabled(chatId) ? 'включено' : 'выключено'}`,
    `📝 Текст: ${service.getMenuText(chatId) || 'не задан'}`,
    '',
    'Выберите, что хотите изменить:',
    '• изменить текст',
    '• настроить кнопки, ряды и ссылки',
    '• добавить или удалить медиа',
  ].join('\n');
  await ctx.editMessageText(text, { reply_markup: buildSettingsFirstMessageKeyboard(chatId) });
}

async function showSettingsFirstMessageButtonsMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  const text = [
    '🧩 Настройка кнопок первого сообщения',
    '',
    'Доступно:',
    '• добавить или удалить ряд',
    '• добавить или убрать кнопку',
    '• задать текст кнопки и ссылку, куда она ведёт',
  ].join('\n');
  await ctx.editMessageText(text, { reply_markup: buildSettingsFirstMessageButtonsKeyboard(chatId) });
}

async function showSettingsRulesMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  const service = activeModerationService || defaultModerationService;
  const rules = service.getRules(chatId);
  const enabled = service.isRulesEnabled(chatId);
  const text = [
    buildSettingsRulesMenuText(chatId, rules),
    '',
    `Статус функции правил: ${enabled ? 'включена' : 'отключена'}`,
  ].join('\n');

  await ctx.editMessageText(text, { reply_markup: buildSettingsRulesKeyboard(chatId) });
}

async function showSettingsBanwordsMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  const service = activeModerationService || defaultModerationService;
  const mode = service.getBanwordPunishmentMode(chatId);
  const deleteMessages = service.getBanwordDeleteMessages(chatId);
  const modeText = {
    off: 'Выкл',
    warn: 'Варн',
    mute: 'Замутить',
    ban: 'Забанить',
  }[mode] || 'Выкл';

  const text = [
    '🚫 Запрещенные слова',
    '',
    'В этом меню вы можете установить наказание для тех, кто использует слова, которые вы решили запретить.',
    '',
    `Наказание: ${modeText}`,
    `Удалять сообщения: ${deleteMessages ? '✔️' : '❌'}`,
  ].join('\n');

  await safeEditMessageText(ctx, text, { reply_markup: buildSettingsBanwordsKeyboard(chatId) });
}

async function showSettingsBanwordsListMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  const service = activeModerationService || defaultModerationService;
  const words = service.getBanWords(chatId);

  const listText = [
    '📋 Список запрещенных слов',
    '',
    words.length ? `Всего слов: ${words.length}\n\n• ${words.join('\n• ')}` : 'Список пуст.',
  ].join('\n');

  const backKeyboard = {
    inline_keyboard: [[{ text: 'Назад', callback_data: `settings:banword_list_back:${chatId}` }]],
  };

  await safeEditMessageText(ctx, listText, { reply_markup: backKeyboard });
}

function buildSettingsWarnsKeyboard(chatId) {
  const service = activeModerationService || defaultModerationService;
  const mode = service.getWarnPunishmentMode(chatId);
  const limit = service.getWarnLimit(chatId);

  return {
    inline_keyboard: [
      [{ text: 'Список предупреждений', callback_data: `settings:warn_list:${chatId}` }],
      [
        { text: mode === 'off' ? '✅ Выкл' : 'Выкл', callback_data: `settings:warn_mode:${chatId}:off` },
        { text: mode === 'kick' ? '✅ Исключить' : 'Исключить', callback_data: `settings:warn_mode:${chatId}:kick` },
      ],
      [
        { text: mode === 'mute' ? '✅ Замутить' : 'Замутить', callback_data: `settings:warn_mode:${chatId}:mute` },
        { text: mode === 'ban' ? '✅ Забанить' : 'Забанить', callback_data: `settings:warn_mode:${chatId}:ban` },
      ],
      [{ text: 'Лимит предупреждений', callback_data: `settings:warn_limit_menu:${chatId}` }],
      [{ text: 'Время бана', callback_data: `settings:warn_duration_menu:${chatId}` }],
      [{ text: 'Амнистия', callback_data: `settings:warn_amnesty:${chatId}` }],
      [{ text: 'Назад', callback_data: `settings:main:${chatId}` }],
    ],
  };
}

async function showSettingsWarnsMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  const service = activeModerationService || defaultModerationService;
  const mode = service.getWarnPunishmentMode(chatId);
  const limit = service.getWarnLimit(chatId);
  const duration = service.getWarnBlockDuration(chatId);

  const modeText = {
    off: 'Выкл',
    kick: 'Исключить',
    mute: 'Замутить',
    ban: 'Забанить',
  }[mode] || 'Выкл';

  const durationText = duration === 0 ? '∞ Навсегда' : `${duration} часов`;

  const text = [
    '⚠️ Управление предупреждениями',
    '',
    'В этом меню вы можете установить наказание при достижении лимита предупреждений.',
    '',
    `Наказание: ${modeText}`,
    `Лимит предупреждений: ${limit}`,
    `Длительность блокировки: ${durationText}`,
  ].join('\n');

  await safeEditMessageText(ctx, text, { reply_markup: buildSettingsWarnsKeyboard(chatId) });
}

function buildSettingsWarnsLimitKeyboard(chatId) {
  const service = activeModerationService || defaultModerationService;
  const limit = service.getWarnLimit(chatId);

  return {
    inline_keyboard: [
      [
        { text: limit === 2 ? '✅ 2' : '2', callback_data: `settings:warn_limit:${chatId}:2` },
        { text: limit === 3 ? '✅ 3' : '3', callback_data: `settings:warn_limit:${chatId}:3` },
        { text: limit === 4 ? '✅ 4' : '4', callback_data: `settings:warn_limit:${chatId}:4` },
        { text: limit === 5 ? '✅ 5' : '5', callback_data: `settings:warn_limit:${chatId}:5` },
        { text: limit === 6 ? '✅ 6' : '6', callback_data: `settings:warn_limit:${chatId}:6` },
      ],
      [{ text: 'Назад', callback_data: `settings:warn_menu:${chatId}` }],
    ],
  };
}

function buildSettingsWarnsDurationKeyboard(chatId) {
  const service = activeModerationService || defaultModerationService;
  const duration = service.getWarnBlockDuration(chatId);

  const options = [1, 2, 4, 6, 12, 24, 48, 72, 168, 720];

  return {
    inline_keyboard: [
      [
        ...options.slice(0, 5).map((value) => ({
          text: duration === value ? `✅ ${value}ч` : `${value}ч`,
          callback_data: `settings:warn_duration:${chatId}:${value}`,
        })),
      ],
      [
        ...options.slice(5).map((value) => ({
          text: duration === value ? `✅ ${value}ч` : `${value}ч`,
          callback_data: `settings:warn_duration:${chatId}:${value}`,
        })),
      ],
      [
        { text: duration === 0 ? '✅ ∞ Навсегда' : '∞ Навсегда', callback_data: `settings:warn_duration:${chatId}:0` },
        { text: '✍️ Кастом', callback_data: `settings:warn_duration_custom:${chatId}` },
      ],
      [{ text: 'Назад', callback_data: `settings:warn_menu:${chatId}` }],
    ],
  };
}

async function showSettingsWarnsListMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  const service = activeModerationService || defaultModerationService;
  const warnings = service.getAllWarnings(chatId);

  const listText = warnings.length
    ? '📋 Предупреждения пользователей\n\n' + warnings
        .map(([userId, count]) => `• Пользователь ${userId}: ${count}/${service.getWarnLimit(chatId)}`)
        .join('\n')
    : '📋 Предупреждения пользователей\n\nНет предупреждений.';

  const backKeyboard = {
    inline_keyboard: [[{ text: 'Назад', callback_data: `settings:warn_menu:${chatId}` }]],
  };

  await safeEditMessageText(ctx, listText, { reply_markup: backKeyboard });
}

function parseSettingsAction(action) {
  const parts = String(action || '').split(':').filter(Boolean);
  const isPrefixed = parts[0] === 'settings' && parts.length > 1;
  const normalizedParts = isPrefixed ? parts.slice(1) : parts;
  const actionType = normalizedParts[0] || '';
  const target = actionType === 'select' ? 'select' : actionType;

  let parsedChatId = 0;
  let value = '';
  let extra = '';
  const args = normalizedParts.slice(1);
  const chatIdIndex = args.findIndex((part) => /^-?\d+$/.test(part));

  if (chatIdIndex >= 0) {
    const maybeChatId = Number(args[chatIdIndex]);
    parsedChatId = Number.isFinite(maybeChatId) ? maybeChatId : 0;
  }

  const remainingArgs = args.filter((_, index) => index !== chatIdIndex);
  const nonNumericRemaining = remainingArgs.filter((part) => !/^-?\d+$/.test(part));

  if (actionType === 'select') {
    value = String(normalizedParts[normalizedParts.length - 1] || '');
  } else if (actionType === 'captcha_timeout_set' && normalizedParts.length >= 3) {
    parsedChatId = Number(normalizedParts[1]) || 0;
    value = normalizedParts[2] || '';
  } else if (actionType === 'captcha_mode' && normalizedParts.length >= 3) {
    parsedChatId = Number(normalizedParts[1]) || 0;
    value = normalizedParts[2] || '';
  } else if (actionType === 'toggle_captcha' && normalizedParts.length >= 3) {
    parsedChatId = Number(normalizedParts[1]) || 0;
    value = normalizedParts[2] || '';
  } else if (actionType === 'captcha_modes' && normalizedParts.length >= 2) {
    parsedChatId = Number(normalizedParts[1]) || 0;
    value = '';
  } else if (actionType === 'captcha_timeout' && normalizedParts.length >= 2) {
    parsedChatId = Number(normalizedParts[1]) || 0;
    value = '';
  } else if (nonNumericRemaining.length > 0) {
    value = String(nonNumericRemaining[0] || '');
    extra = String(nonNumericRemaining[1] || '');
  } else if (remainingArgs.length > 0) {
    value = String(remainingArgs[remainingArgs.length - 1] || '');
  }

  return {
    type: actionType,
    target,
    chatId: parsedChatId,
    section: actionType === 'section' ? normalizedParts[1] || '' : '',
    value,
    extra,
  };
}

async function openSettingsForCurrentContext(ctx, targetChatId = null) {
  const chatId = Number(targetChatId || ctx.chat?.id || 0);
  if (!chatId) {
    return;
  }

  if (!await canManageGroupSettings(ctx, chatId)) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  await showSettingsMainMenu(ctx, chatId);
}

function parseSettingsTarget(action) {
  const parts = String(action || '').split(':');
  return Number(parts[parts.length - 1]) || 0;
}

function parseSettingsValue(action) {
  const parts = String(action || '').split(':');
  return parts[parts.length - 1] || '';
}

function parseSettingsSection(action) {
  const parts = String(action || '').split(':');
  return parts[2] || '';
}

function parseSettingsChatId(action) {
  const parts = String(action || '').split(':');
  return Number(parts[parts.length - 1] || 0);
}

function buildSettingsPendingAction(action, chatId, extra = {}) {
  return { action, groupId: Number(chatId), ...extra };
}

function parseSettingsPrompt(action) {
  if (action === 'settings_message_text') {
    return 'Отправьте новый текст первого сообщения.';
  }
  if (action === 'settings_link_add') {
    return 'Отправьте ссылку или домен для добавления в список разрешённых.';
  }
  if (action === 'settings_link_remove') {
    return 'Отправьте ссылку или домен для удаления из списка разрешённых.';
  }
  if (action === 'settings_forward_add') {
    return 'Отправьте @username, t.me/username или ID пользователя/канала/группы для добавления в исключения пересылок.';
  }
  if (action === 'settings_forward_remove') {
    return 'Отправьте @username, t.me/username или ID пользователя/канала/группы для удаления из исключений пересылок.';
  }
  if (action === 'settings_anonymous_channel_add') {
    return 'Отправьте @username, t.me/username или ID канала для добавления в исключения.';
  }
  if (action === 'settings_anonymous_channel_remove') {
    return 'Отправьте @username, t.me/username или ID канала для удаления из исключений.';
  }
  if (action === 'settings_rules_set') {
    return 'Отправьте новые правила для группы.';
  }
  if (action === 'settings_banword_add') {
    return 'Отправьте слово или несколько слов для добавления.\nПоддерживаются форматы:\n• Через запятую: нарко, соль, травка\n• Через перевод строки: нарко\nсоль\nтравка';
  }
  if (action === 'settings_banword_remove') {
    return 'Отправьте слово или несколько слов для удаления.\nПоддерживаются форматы:\n• Через запятую: нарко, соль, травка\n• Через перевод строки: нарко\nсоль\nтравка';
  }
  return '';
}

function parsePunishmentDetails(args, hasReply) {
  const parts = args ? args.trim().split(/\s+/).filter(Boolean) : [];
  let durationHours = null;
  let reasonParts = parts;

  if (!hasReply && parts.length > 0) {
    reasonParts = parts.slice(1);
  }

  const durationToken = parts[0];
  if (durationToken && /^\d+[mhd]$/i.test(durationToken)) {
    const amount = Number(durationToken.slice(0, -1));
    const unit = durationToken.at(-1).toLowerCase();
    if (unit === 'm') {
      durationHours = amount / 60;
    } else if (unit === 'h') {
      durationHours = amount;
    } else if (unit === 'd') {
      durationHours = amount * 24;
    }
    reasonParts = parts.slice(1);
  }

  const reason = reasonParts.join(' ').trim() || 'Без причины';
  return { durationHours, reason };
}

function formatDurationLabel(durationHours) {
  if (durationHours === null || durationHours === undefined) {
    return 'без срока';
  }
  if (durationHours < 1) {
    return `${Math.round(durationHours * 60)}м`;
  }
  if (durationHours < 24) {
    return `${Math.round(durationHours)}ч`;
  }
  return `${Math.round(durationHours / 24)}д`;
}

function buildPunishmentNotification(action, chatTitle, reason, durationHours) {
  const actionName = action === 'ban' ? 'заблокирован(а)' : action === 'mute' ? 'ограничен(а)' : 'наказан(а)';
  const durationLabel = formatDurationLabel(durationHours);
  return `Вы были ${actionName} в чате "${chatTitle}". Причина: ${reason}. Срок: ${durationLabel}.`;
}

function buildModerationAlertMessage(userLabel, durationHours, reason) {
  const durationLabel = formatDurationLabel(durationHours);
  return `⚠️ Пользователь ${userLabel} замучен на ${durationLabel} по причине: ${reason}.`;
}

function buildBulkModerationSummaryMessage(userLabel, reasons = []) {
  const uniqueReasons = Array.from(new Set((Array.isArray(reasons) ? reasons : [reasons])
    .map((reason) => String(reason || '').trim())
    .filter(Boolean)));

  if (uniqueReasons.length === 0) {
    return `⚠️ Автопроверка: пользователь ${userLabel} удалил сообщения.`;
  }

  const reasonText = uniqueReasons.slice(0, 3).join(', ');
  const suffix = uniqueReasons.length > 3 ? `, и ещё ${uniqueReasons.length - 3}` : '';
  return `⚠️ Автопроверка: пользователь ${userLabel} удалил сообщения по причине: ${reasonText}${suffix}.`;
}

function buildCaptchaChallenge(mode = 'emoji', displayName = 'пользователь') {
  const normalizedMode = String(mode || 'emoji').trim().toLowerCase();
  if (normalizedMode === 'math') {
    const prompt = 'Капча для пользователя ' + displayName + '. Реши пример: 2 + 3';
    return {
      prompt,
      options: ['5', '4', '6', '7'],
      correctOption: '5',
      mode: normalizedMode,
    };
  }

  if (normalizedMode === 'color') {
    const prompt = 'Капча для пользователя ' + displayName + '. Выбери цвет: синий';
    return {
      prompt,
      options: ['синий', 'красный', 'зелёный', 'жёлтый'],
      correctOption: 'синий',
      mode: normalizedMode,
    };
  }

  if (normalizedMode === 'word') {
    const prompt = 'Капча для пользователя ' + displayName + '. Выбери слово: кот';
    const options = ['кот', 'дом', 'море', 'солнце'];
    const shuffled = [...options].sort(() => Math.random() - 0.5);
    const target = 'кот';
    return {
      prompt,
      options: shuffled,
      correctOption: target,
      mode: normalizedMode,
    };
  }

  const emojis = ['🐶', '🐱', '🦊', '🐼'];
  const target = emojis[Math.floor(Math.random() * emojis.length)];
  const options = emojis.filter((emoji) => emoji !== target);
  const shuffled = [...options].sort(() => Math.random() - 0.5);
  return {
    prompt: 'Капча для пользователя ' + displayName + '. Выбери ' + target,
    options: shuffled,
    correctOption: target,
    mode: normalizedMode,
  };
}

function generateCaptchaPollOptions(challenge) {
  if (!challenge || !Array.isArray(challenge.options) || !challenge.correctOption) {
    return [];
  }

  return [...new Set([...challenge.options, challenge.correctOption])].sort(() => Math.random() - 0.5);
}

function shouldStartCaptchaForChat(chatId, moderationService) {
  if (!chatId || !moderationService || typeof moderationService.isCaptchaEnabled !== 'function') {
    return false;
  }
  return moderationService.isCaptchaEnabled(chatId);
}

function getCaptchaEmojiSet() {
  return buildCaptchaChallenge('emoji');
}

function buildFunReply(kind) {
  if (kind === 'coin') {
    return Math.random() > 0.5 ? 'Орёл' : 'Решка';
  }
  if (kind === 'dice') {
    return String(Math.floor(Math.random() * 6) + 1);
  }
  if (kind === 'fate') {
    const answers = [
      'Да',
      'Нет',
      'Возможно',
      'Скорее да',
      'Скорее нет',
      'Никогда не угадаешь',
      'Сделай это уже',
      'Хватит думать, пора действовать',
      'Нет смысла тянуть, делай сегодня',
      'Это твой шанс, не просри его',
      'Подумай, а потом сделай, иначе скоро пожалеешь',
      'Если ты ещё сомневаешься, то ты уже запорол момент',
      'Не будь мудаком, сделай нормально',
      'Перестань быть говном и займись делом',
      'Хватит ходить на работу на трассу, сделай что-то стоящее',
      'Пиздец, когда ты уже возьмёшься за это?',
      'Бросай это говно и займись чем-то полезным',
      'Если ты не сделаешь это сейчас, то будет ещё хуже',
      'Даже если тебя это бесит, тебе надо поступить правильно',
      'Ляжь спать иничего не делай, завтра будет хуже',
      'Спасибо что ты есть, ты делаешь все правильно'
    ];
    return answers[Math.floor(Math.random() * answers.length)];
  }
  if (kind === 'compliment') {
    const replies = [
      'у тебя очень приятная энергия',
      'ты делаешь этот чат лучше',
      'ты невероятно добрый человек',
      'ты умеешь вдохновлять',
      'у тебя шикарный вкус',
      'ты — лучшая часть этого чата',
      'ты сегодня сияешь как солнце',
      'ты словно человек, который может поднять настроение любому',
      'твой юмор дороже любого подарка',
      'ты — настоящий двигатель позитивной жопы',
      'ты — огонь, который не тушит ни одна хуйня',
      'ты — редкий цветок в этом говне',
      'ты — просто красавчик(ца), и это не шутка',

    ];
    return replies[Math.floor(Math.random() * replies.length)];
  }
  if (kind === 'insult') {
    const replies = [
      'ты — пиздец с человеческим лицом',
      'ты такой долбоёб, что даже Wi-Fi начинает от тебя отказываться',
      'ты — ходячий говноплан, но тебе будто нравится',
      'ты — ебаный шлак, который ещё и считает себя крутым',
      'ты — тип, которому стоило бы выключить мозг и не включать его снова',
      'ты — мудак, который делает этот чат живее, но от этого не лучше',
      'ты — серый кардинал дурдома, но без кардинального смысла',
      'ты — феерический пиздеж, который ещё не понял, где кончается реальность',
      'ты обосрался, от инсульта',
      'хватит спать уже, ты — живой труп, который ещё не понял, что он мёртв',
    ];
    return replies[Math.floor(Math.random() * replies.length)];
  }
  return 'Пока что нет такой игры.';
}

function parsePageNumber(input = '') {
  const trimmed = String(input || '').trim();
  if (!trimmed) {
    return 1;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function buildPunishmentListMessage(kind, punishments, page, pageSize = 10) {
  const title = kind === 'mute' ? 'Муты' : 'Баны';
  const safePunishments = Array.isArray(punishments) ? punishments : [];
  const totalPages = Math.max(1, Math.ceil(safePunishments.length / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = (safePage - 1) * pageSize;
  const end = start + pageSize;
  const pageItems = safePunishments.slice(start, end);

  if (!pageItems.length) {
    return `${title} (страница ${safePage}/${totalPages})\nПока нет активных записей.`;
  }

  const lines = pageItems.map((item, index) => {
    const userLabel = item.userId ? `User ${item.userId}` : 'Неизвестный пользователь';
    const reason = item.reason ? ` — ${item.reason}` : '';
    const untilLabel = item.untilAt ? ` — до ${new Date(item.untilAt * 1000).toLocaleString('ru-RU')}` : '';
    return `${start + index + 1}. ${userLabel}${reason}${untilLabel}`;
  });

  return `${title} (страница ${safePage}/${totalPages})\n${lines.join('\n')}`;
}

function buildBotAdminListMessage(primaryAdminLabel, auxiliaryAdminLabels = []) {
  // Backwards-compatible: if called with two args (primaryLabel, auxLabelsArray)
  if (typeof primaryAdminLabel === 'string' && Array.isArray(auxiliaryAdminLabels)) {
    const grouped = { '1': [], '2': [], '3': [], '4': [], '5': [] };
    if (primaryAdminLabel) grouped['1'].push(String(primaryAdminLabel));
    (auxiliaryAdminLabels || []).forEach((lbl) => grouped['2'].push(lbl));
    primaryAdminLabel = grouped;
  }

  const groupedByLevel = primaryAdminLabel || { '1': [], '2': [], '3': [], '4': [], '5': [] };
  const levelNames = {
    1: 'Главный админ',
    2: 'Ведущий админ',
    3: 'Старший админ',
    4: 'Средний админ',
    5: 'Младший админ',
  };

  const lines = ['🤖 Администраторы бота'];
  for (let level = 1; level <= 5; level += 1) {
    const labels = Array.isArray(groupedByLevel[String(level)]) ? groupedByLevel[String(level)] : [];
    const stars = '⭐️'.repeat(level);
    lines.push(`${stars}${levelNames[level]}:`);
    if (labels.length) {
      labels.forEach((label, idx) => lines.push(`${idx + 1}. ${label}`));
    } else {
      lines.push('1. —');
    }
  }

  return lines.join('\n');
}

const ai = require('./ai');

function shouldFailClosedForMedia(payload, errorMessage = '', normalizedAnswer = '') {
  if (!payload || !payload.type) {
    return false;
  }

  const isStickerOrAnim = payload.type === 'sticker' || payload.type === 'animation';
  if (!isStickerOrAnim) {
    return false;
  }

  const text = String(errorMessage || normalizedAnswer || '').trim();
  if (!text) {
    return false;
  }

  const safePatterns = /(?:^|[^\p{L}\p{N}])(?:нет|no|false|safe|безопасно|безопасный|not adult|no adult|не содержит|не содержит взросл|не содержит порно|не содержит обнаж)(?:$|[^\p{L}\p{N}])/iu;
  if (safePatterns.test(text)) {
    return false;
  }

  const explicitAdultPatterns = /(?:^|[^\p{L}\p{N}])(?:да|yes|true|adult|18\+|porn|порно|эротик|эротика|нагота|голая|сексуал|nude|nudity|sexual|sexy|explicit|обнаж|интим|intimate|xx|nsfw)(?:$|[^\p{L}\p{N}])/iu;
  if (explicitAdultPatterns.test(text)) {
    return true;
  }

  const invalidImagePatterns = /invalid image|not represent a valid image|unsupported image|image data you provided|невалидн|not a valid image|unsupported media/i;
  if (invalidImagePatterns.test(text) && /(?:^|\s)(?:18\+|adult|porn|порно|эротик|нагота|обнаж|сексу|nude|nudity|sexual)(?:\s|$)/iu.test(text)) {
    return true;
  }

  return false;
}

function createBot() {
  const config = loadConfig();
  const bot = new Telegraf(config.botToken || '');
  const storageDir = path.dirname(config.databasePath || 'data/bot.json');
  const moderationStoragePath = path.join(storageDir, 'moderation.json');
  const userStoragePath = path.join(storageDir, 'users.json');
  const userService = new UserService(userStoragePath);
  const moderationService = new ModerationService(moderationStoragePath);
  const database = new Database(config.databasePath);
  activeDatabase = database;
  activeModerationService = moderationService;
  activeConfig = config;
  const punishmentTimers = new Map();
  const spamActivity = new Map();
  const messageHistory = new Map();
  const captchaStates = new Map();
  const agreementStates = new Map();
  const pendingMenuActions = new Map();
  const pendingSettingsActions = new Map();

  function getPunishmentTimerKey(chatId, userId, action) {
    return `${chatId}:${userId}:${action}`;
  }

  function clearScheduledPunishment(chatId, userId, action) {
    const key = getPunishmentTimerKey(chatId, userId, action);
    const timer = punishmentTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      punishmentTimers.delete(key);
    }
  }

  function buildMutePermissions(enabled = true) {
    return {
      can_send_messages: enabled,
      can_send_media_messages: enabled,
      can_send_polls: enabled,
      can_send_other_messages: enabled,
      can_add_web_page_previews: enabled,
      can_change_info: false,
      can_invite_users: false,
      can_pin_messages: false,
      can_manage_topics: false,
    };
  }

  function isCapsFlood(text) {
    if (!text || typeof text !== 'string') {
      return false;
    }

    const letters = text.match(/[A-Za-zА-Яа-яЁё]/g) || [];
    if (letters.length < 5) {
      return false;
    }

    const uppercaseCount = letters.filter((ch) => ch === ch.toUpperCase()).length;
    return uppercaseCount / letters.length >= 0.7;
  }

  function hasRepeatedCharacterFlood(text) {
    if (!text || typeof text !== 'string') {
      return false;
    }

    let maxRun = 1;
    let currentRun = 1;
    for (let i = 1; i < text.length; i += 1) {
      if (text[i] === text[i - 1]) {
        currentRun += 1;
        maxRun = Math.max(maxRun, currentRun);
      } else {
        currentRun = 1;
      }
    }

    return maxRun >= 7;
  }

  function isAntiFloodViolation(text) {
    return isCapsFlood(text) || hasRepeatedCharacterFlood(text);
  }

  async function startCaptchaForUser(ctx, userId, joinUser = null) {
    if (!isGroupChat(ctx)) {
      return;
    }

    const chatId = Number(ctx.chat.id);
    const memberUser = joinUser || ctx.chatMember?.new_chat_member?.user || ctx.update?.chat_member?.new_chat_member?.user || null;
    const displayName = memberUser?.first_name || memberUser?.username || 'пользователь';
    const moderationService = activeModerationService || defaultModerationService;
    if (!shouldStartCaptchaForChat(chatId, moderationService)) {
      return;
    }
    const mode = moderationService.getCaptchaMode(chatId);
    const challenge = buildCaptchaChallenge(mode, displayName);
    const shuffledOptions = generateCaptchaPollOptions(challenge);
    const correctOptionId = shuffledOptions.indexOf(challenge.correctOption);
    const timeoutMinutes = moderationService.getCaptchaTimeoutMinutes(chatId);

    let pollMessage;
    try {
      pollMessage = await ctx.telegram.sendPoll(chatId,
        challenge.prompt,
        shuffledOptions,
        {
          type: 'quiz',
          correct_option_id: correctOptionId,
          is_anonymous: false,
          open_period: timeoutMinutes * 60,
          disable_notification: true,
        }
      );
    } catch (error) {
      await ctx.telegram.sendMessage(chatId, `Не удалось создать капчу в группе для пользователя ${displayName}. Пожалуйста, проверьте права бота.`);
      return;
    }

    const pollId = pollMessage?.poll?.id;
    const pollMessageId = pollMessage?.message_id;
    if (!pollId || !pollMessageId) {
      await ctx.telegram.sendMessage(chatId, `Не удалось создать капчу для пользователя ${displayName}.`);
      return;
    }

    await ctx.telegram.restrictChatMember(chatId, userId, buildMutePermissions(false));
    const instructionMessage = await ctx.telegram.sendMessage(chatId, `Пользователь ${displayName} должен пройти капчу в этом чате, чтобы писать сообщения.`, {
      disable_notification: true,
    });
    scheduleDeleteMessage(ctx.telegram, chatId, instructionMessage?.message_id);

    captchaStates.set(pollId, {
      chatId,
      userId,
      displayName,
      correctOptionId,
      pollMessageId,
      instructionMessageId: instructionMessage?.message_id,
      createdAt: Date.now(),
    });
  }

  async function cleanupAgreementMessages(telegram, chatId, messageIds = []) {
    if (!telegram || !chatId || !Array.isArray(messageIds)) {
      return;
    }

    const uniqueIds = [...new Set(messageIds.filter((messageId) => Number.isFinite(Number(messageId)) && Number(messageId) > 0))];
    for (const messageId of uniqueIds) {
      try {
        await telegram.deleteMessage(chatId, Number(messageId));
      } catch (deleteError) {
        // ignore deletion errors for already-removed agreement messages
      }
    }
  }

  async function handleAgreementDecision(telegram, state, accepted) {
    if (!state || !telegram) {
      return;
    }

    const messageIds = Array.isArray(state.agreementMessageIds) ? state.agreementMessageIds : [];
    if (state.pollMessageId) {
      messageIds.push(state.pollMessageId);
    }

    await cleanupAgreementMessages(telegram, state.chatId, messageIds);

    if (accepted) {
      await telegram.restrictChatMember(state.chatId, state.userId, buildMutePermissions(true));
      const acceptedMessage = await telegram.sendMessage(state.chatId, `Пользователь ${state.displayName} подтвердил соглашение и получил доступ к чату.`);
      scheduleDeleteMessage(telegram, state.chatId, acceptedMessage?.message_id);
      return;
    }

    await telegram.restrictChatMember(state.chatId, state.userId, buildMutePermissions(false));
    const rejectedMessage = await telegram.sendMessage(state.chatId, `Пользователь ${state.displayName} не согласился с правилами. Доступ к чату не выдан.`);
    scheduleDeleteMessage(telegram, state.chatId, rejectedMessage?.message_id);
  }

  function scheduleDeleteForContext(ctx, messageId, delay = 5000) {
    if (!ctx?.chat || !messageId) {
      return;
    }
    scheduleDeleteMessage(ctx.telegram, ctx.chat.id, messageId, delay);
  }

  async function replyWithAutoDelete(ctx, text, extra = {}, delay = 5000) {
    const sentMessage = await ctx.reply(text, extra);
    scheduleDeleteForContext(ctx, sentMessage?.message_id, delay);
    return sentMessage;
  }

  const bulkModerationReports = new Map();

  function queueBulkModerationSummary(ctx, userId, reason) {
    if (!isGroupChat(ctx) || !Number.isFinite(Number(userId))) {
      return;
    }

    const normalizedReason = String(reason || '').trim();
    if (!normalizedReason) {
      return;
    }

    const chatId = Number(ctx.chat.id);
    const key = `${chatId}:${Number(userId)}`;
    const current = bulkModerationReports.get(key) || { reasons: new Set(), timer: null };
    current.reasons.add(normalizedReason);
    bulkModerationReports.set(key, current);

    if (current.timer) {
      return;
    }

    current.timer = setTimeout(async () => {
      const pending = bulkModerationReports.get(key);
      bulkModerationReports.delete(key);
      if (!pending || pending.reasons.size === 0) {
        return;
      }

      const userLabel = getMentionText(ctx.from || { id: userId }) || `Пользователь ${userId}`;
      const messageText = buildBulkModerationSummaryMessage(userLabel, Array.from(pending.reasons));
      try {
        const sentMessage = await ctx.reply(messageText);
        scheduleDeleteForContext(ctx, sentMessage?.message_id, 3000);
      } catch (error) {
        // ignore summary errors for transient moderation events
      }
    }, 1500);
  }

  async function completeCaptcha(ctx, pollId, passed) {
    const state = captchaStates.get(pollId);
    if (!state) {
      return;
    }

    captchaStates.delete(pollId);

    if (passed) {
      const moderationService = activeModerationService || defaultModerationService;
      const agreementEnabled = moderationService.isAgreementEnabled(state.chatId);

      if (agreementEnabled) {
        const agreementText = moderationService.getAgreementText(state.chatId) || 'Прочитайте правила и подтвердите согласие.';
        
        // Telegram polls have no separate text body, so the rules are the poll question.
        const combinedText = `${agreementText}\n\n➖➖➖➖➖➖➖➖\nВы ознакомились с правилами и соглашаетесь с ними?`;
        const pollQuestion = combinedText.length > 300
          ? `${combinedText.slice(0, 297)}...`
          : combinedText;

        const agreementPoll = await ctx.telegram.sendPoll(state.chatId,
          pollQuestion,
          ['Согласен с правилами', 'Не согласен'],
          {
            type: 'quiz',
            correct_option_id: 0,
            is_anonymous: false,
            open_period: 300,
            disable_notification: true,
          }
        );

        agreementStates.set(agreementPoll?.poll?.id, {
          chatId: state.chatId,
          userId: state.userId,
          displayName: state.displayName,
          pollMessageId: agreementPoll?.message_id,
          createdAt: Date.now(),
        });

        scheduleDeleteMessage(ctx.telegram, state.chatId, state.pollMessageId);
        scheduleDeleteMessage(ctx.telegram, state.chatId, state.instructionMessageId);
        return;
      }

      await ctx.telegram.restrictChatMember(state.chatId, state.userId, buildMutePermissions(true));
      const sentGroupMessage = await ctx.telegram.sendMessage(state.chatId, `Пользователь ${state.displayName} прошёл капчу и получил доступ к чату.`);
      scheduleDeleteMessage(ctx.telegram, state.chatId, sentGroupMessage?.message_id);
      scheduleDeleteMessage(ctx.telegram, state.chatId, state.pollMessageId);
      scheduleDeleteMessage(ctx.telegram, state.chatId, state.instructionMessageId);
      return;
    }

    try {
      await ctx.telegram.kickChatMember(state.chatId, state.userId);
    } catch (error) {
      // ignore if the user cannot be removed
    }

    const failedGroupMessage = await ctx.telegram.sendMessage(state.chatId, `Пользователь ${state.displayName} не прошёл капчу и исключён из группы.`);
    scheduleDeleteMessage(ctx.telegram, state.chatId, failedGroupMessage?.message_id);
    scheduleDeleteMessage(ctx.telegram, state.chatId, state.pollMessageId);
  }

  async function expirePunishment(punishment) {
    const { chatId, userId, action } = punishment;
    clearScheduledPunishment(chatId, userId, action);

    const active = database.findActivePunishment(chatId, userId, action);
    if (!active) {
      return;
    }

    try {
      if (action === 'mute') {
        await bot.telegram.restrictChatMember(chatId, userId, buildMutePermissions(true));
      } else if (action === 'ban') {
        await bot.telegram.unbanChatMember(chatId, userId, true);
      }
      database.removeActivePunishment(chatId, userId, action);
      database.addPunishment(chatId, userId, `expire_${action}`, `Автоматическое снятие ${action}`);

    } catch (error) {
      console.error(`Не удалось автоматически снять ${action} для ${userId} в чате ${chatId}:`, error?.message || error);
    }
  }

  function schedulePunishmentExpiry(punishment) {
    if (!punishment?.untilAt) {
      return;
    }

    const delay = punishment.untilAt * 1000 - Date.now();
    if (delay <= 0) {
      void expirePunishment(punishment);
      return;
    }

    const key = getPunishmentTimerKey(punishment.chatId, punishment.userId, punishment.action);
    clearScheduledPunishment(punishment.chatId, punishment.userId, punishment.action);
    const timer = setTimeout(() => {
      void expirePunishment(punishment);
    }, delay);
    punishmentTimers.set(key, timer);
  }

  async function initializeScheduledPunishments() {
    const activePunishments = database.getAllActivePunishments();
    for (const punishment of activePunishments) {
      if (punishment.untilAt) {
        if (punishment.untilAt <= Math.floor(Date.now() / 1000)) {
          await expirePunishment(punishment);
        } else {
          schedulePunishmentExpiry(punishment);
        }
      }
    }
  }

  void initializeScheduledPunishments();

  function isBotAdmin(ctx) {
    const userId = ctx.from?.id;
    if (!userId) {
      return false;
    }
    return database.isBotAdmin(ctx.chat.id, userId) || config.adminIds.includes(userId);
  }

  async function canUseAdminPunishmentCommands(ctx) {
    if (isBotAdmin(ctx)) {
      return true;
    }

    const userId = Number(ctx.from?.id);
    const chatId = Number(ctx.chat?.id);
    if (!Number.isFinite(userId) || !Number.isFinite(chatId) || !isGroupChat(ctx)) {
      return false;
    }

    try {
      const member = await ctx.telegram.getChatMember(chatId, userId);
      return isGroupOwnerMember(member) || String(member?.status || '').toLowerCase() === 'administrator';
    } catch (error) {
      return false;
    }
  }

  function isGroupChat(ctx) {
    const type = ctx.chat?.type;
    return type === 'group' || type === 'supergroup';
  }

  function isPrivateChat(ctx) {
    return ctx.chat?.type === 'private';
  }

  function getMessageText(ctx) {
    return String(ctx.message?.text || ctx.message?.caption || '').trim();
  }

  async function safeAnswerCbQuery(ctx, text) {
    try {
      if (typeof text === 'string') {
        await ctx.answerCbQuery(text);
      } else {
        await ctx.answerCbQuery();
      }
    } catch (error) {
      // ignore stale or invalid callback query errors
    }
  }

  async function safeEditMessageText(ctx, text, extra = {}) {
    try {
      await ctx.editMessageText(text, extra);
    } catch (error) {
      const description = error?.response?.description || error?.description || '';
      const retryAfter = Number(error?.response?.parameters?.retry_after ?? error?.parameters?.retry_after ?? error?.retry_after ?? 0);

      if (typeof description === 'string' && description.includes('message is not modified')) {
        return;
      }

      if (retryAfter > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        try {
          await ctx.editMessageText(text, extra);
          return;
        } catch (retryError) {
          const retryDescription = retryError?.response?.description || retryError?.description || '';
          if (typeof retryDescription === 'string' && retryDescription.includes('message is not modified')) {
            return;
          }
        }
      }

      throw error;
    }
  }

  function isMediaMessage(ctx) {
    const message = ctx.message || {};
    return Boolean(message.photo || message.video || message.document || message.animation || message.audio || message.voice || message.sticker || message.video_note);
  }

  function isKnownCommandText(text) {
    const slashCommand = /^\/(start|help|id|about|whoami|stats|rules|allowed|links|hug|kiss|slap|poke|fuck|rape|beat|kill|bite|lick|lickup|coin|dice|fate|compliment|insult|top|admins|banlist|mutelist|setrules|warn|delwarn|warnings|unwarn|mute|delmute|unmute|ban|delban|unban|setgreeting|addadmin|removeadmin|promote|demote|clearhistory|miniapp|admincom|ai)(\s|$)/i;
    const bangCommand = /^!(delban|delmute|delwarn|начало|помощь|айди|информация|кто\s*я|статистика|правила|обнять|поцеловать|шлёпнуть|тыкнуть|монетка|кубик|вопрос|комплимент|инсульт|предупреждение|варны|мут|размут|бан|разбан|топ)(\s|$)/i;
    const plusMinusCommand = /^(\+антиспам|\+antispam|\+антифлуд|\+antiflood|\-антиспам|\-antispam|\-антифлуд|\-antiflood|\+ссылки|\+links|\-ссылки|\-links|\+описание|\+description|\+rules|\+правила|\+greeting|\+приветствие)(\s|$)/i;
    return slashCommand.test(text) || bangCommand.test(text) || plusMinusCommand.test(text);
  }

  function parseBotCommandKey(text) {
    const normalized = String(text || '').trim();
    const plusMinusMatch = normalized.match(/^[+-](антиспам|antispam|антифлуд|antiflood|ссылки|links)\b/i);
    if (plusMinusMatch) {
      const command = plusMinusMatch[1].toLowerCase();
      if (command === 'антиспам' || command === 'antispam') return 'antispam';
      if (command === 'антифлуд' || command === 'antiflood') return 'antiflood';
      return 'antilinks';
    }

    const slashMatch = normalized.match(/^\/([^\s]+)/);
    if (slashMatch) {
      const commandWithBot = slashMatch[1].toLowerCase();
      return commandWithBot.split('@')[0];
    }

    const bangMatch = normalized.match(/^!(\S+)/);
    if (!bangMatch) {
      return null;
    }

    const rawCommand = bangMatch[1].toLowerCase();
    if (/^кто$/.test(rawCommand) && /^!кто\s*я\b/i.test(normalized)) {
      return 'whoami';
    }

    const translationMap = {
      начало: 'start',
      помощь: 'help',
      айди: 'id',
      информация: 'about',
      статистика: 'stats',
      правила: 'rules',
      обнять: 'hug',
      поцеловать: 'kiss',
      шлёпнуть: 'slap',
      шлепнуть: 'slap',
      тыкнуть: 'poke',
      монетка: 'coin',
      кубик: 'dice',
      вопрос: 'fate',
      комплимент: 'compliment',
      инсульт: 'insult',
      предупреждение: 'warn',
      варны: 'warnings',
      мут: 'mute',
      размут: 'unmute',
      бан: 'ban',
      разбан: 'unban',
      топ: 'top',
    };

    return translationMap[rawCommand] || rawCommand;
  }

  async function enforceDisabledCommand(ctx, next) {
    if (!ctx.chat || !isGroupChat(ctx) || !ctx.message) {
      return next();
    }

    const commandKey = parseBotCommandKey(getMessageText(ctx));
    if (!commandKey) {
      return next();
    }

    if (moderationService.isCommandDisabled(ctx.chat.id, commandKey)) {
      await deleteMessageSafely(ctx, ctx.message.message_id);
      return;
    }

    return next();
  }

  bot.use(enforceDisabledCommand);

  function ensureGroup(ctx) {
    database.ensureGroup(ctx.chat.id, ctx.chat.title || String(ctx.chat.id), ctx.chat?.owner_id || null);
  }

  async function deleteMessageSafely(ctx, messageId) {
    if (!messageId) {
      return;
    }
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, messageId);
    } catch (error) {
      console.warn('deleteMessageSafely failed:', {
        chatId: ctx.chat?.id,
        messageId,
        error: error?.response?.description || error?.message || error,
      });
    }
  }

  function recordRecentMessage(ctx) {
    if (!isGroupChat(ctx)) {
      return;
    }

    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;
    const messageId = ctx.message?.message_id;
    if (!Number.isFinite(userId) || !messageId) {
      return;
    }

    const now = Date.now();
    const cutoff = now - 5 * 60 * 1000;
    const chatHistory = messageHistory.get(chatId) || new Map();
    const userHistory = (chatHistory.get(userId) || []).filter((item) => item.timestamp >= cutoff);
    userHistory.push({ messageId, timestamp: now });
    if (userHistory.length > 100) {
      userHistory.splice(0, userHistory.length - 100);
    }
    chatHistory.set(userId, userHistory);
    messageHistory.set(chatId, chatHistory);
  }

  async function deleteRecentMessages(ctx, chatId, userId, minutes = 5) {
    const chatHistory = messageHistory.get(chatId);
    if (!chatHistory) {
      return;
    }

    const now = Date.now();
    const cutoff = now - minutes * 60 * 1000;
    const userHistory = chatHistory.get(userId) || [];
    const toDelete = userHistory.filter((item) => item.timestamp >= cutoff).map((item) => item.messageId);
    const remaining = userHistory.filter((item) => item.timestamp < cutoff);

    if (remaining.length > 0) {
      chatHistory.set(userId, remaining);
    } else {
      chatHistory.delete(userId);
    }

    if (chatHistory.size > 0) {
      messageHistory.set(chatId, chatHistory);
    } else {
      messageHistory.delete(chatId);
    }

    if (toDelete.length === 0) {
      return;
    }

    await Promise.all(toDelete.map((messageId) => deleteMessageSafely(ctx, messageId)));
  }

  async function applyAutomaticMute(ctx, userId, durationHours, reason) {
    const untilDate = Math.floor(Date.now() / 1000) + Math.round(durationHours * 3600);
    await deleteRecentMessages(ctx, ctx.chat.id, userId, 5);

    try {
      await ctx.telegram.restrictChatMember(ctx.chat.id, userId, buildMutePermissions(false), untilDate);
    } catch (error) {
      return;
    }

    database.addPunishment(ctx.chat.id, userId, 'mute', reason, untilDate || null);
    database.addActivePunishment(ctx.chat.id, userId, 'mute', reason, untilDate || null);
    schedulePunishmentExpiry({
      chatId: ctx.chat.id,
      userId,
      action: 'mute',
      untilAt: untilDate,
    });

    if (isGroupChat(ctx)) {
      const userLabel = getMentionText(ctx.from || { id: userId });
      await replyWithAutoDelete(ctx, buildModerationAlertMessage(userLabel, durationHours, reason));
    }

  }

  async function applyBanwordPunishment(ctx, userId, forbiddenWord) {
    const service = activeModerationService || defaultModerationService;
    const mode = service.getBanwordPunishmentMode(ctx.chat.id);
    const deleteMessages = service.getBanwordDeleteMessages(ctx.chat.id);

    // Delete message if deletion is enabled (regardless of punishment mode)
    if (deleteMessages) {
      await deleteMessageSafely(ctx, ctx.message.message_id);
    }

    // Skip punishment if mode is off
    if (mode === 'off') {
      return;
    }

    const reason = `Запрещённое слово: ${forbiddenWord}`;

    if (mode === 'warn') {
      // Add warning
      moderationService.addWarning(ctx.chat.id, userId);
      database.addPunishment(ctx.chat.id, userId, 'warn', reason, null);
      const warningCount = moderationService.getWarnings(ctx.chat.id, userId);
      const warnLimit = moderationService.getWarnLimit(ctx.chat.id);
      const userLabel = getMentionText(ctx.from || { id: userId });
      
      if (warningCount >= warnLimit) {
        // Auto-ban after reaching limit
        const blockDuration = moderationService.getWarnBlockDuration(ctx.chat.id);
        const untilDate = Math.floor(Date.now() / 1000) + Math.round(blockDuration * 3600);
        try {
          await ctx.telegram.banChatMember(ctx.chat.id, userId, untilDate);
        } catch (error) {
          const sentMsg = await premiumEmojis.replyWithCustomEmoji(ctx, `{alert} ${userLabel}: Получил ${warnLimit}-е предупреждение и должен быть забанен, но бот не может выполнить бан.`, { '{alert}': 'warning_alert' }, { parse_mode: 'HTML' });
          scheduleDeleteForContext(ctx, sentMsg?.message_id, 5000);
          return;
        }
        database.addPunishment(ctx.chat.id, userId, 'ban', `Автобан после ${warnLimit} предупреждений. Последнее: ${reason}`, untilDate);
        database.addActivePunishment(ctx.chat.id, userId, 'ban', `Автобан после ${warnLimit} предупреждений. Последнее: ${reason}`, untilDate);
        schedulePunishmentExpiry({
          chatId: ctx.chat.id,
          userId,
          action: 'ban',
          untilAt: untilDate,
        });
        const sentMsg1 = await premiumEmojis.replyWithCustomEmoji(ctx, `{alert} ${userLabel}: Получил ${warnLimit}-е предупреждение и забанен на ${blockDuration}ч.`, { '{alert}': 'warning_alert' }, { parse_mode: 'HTML' });
        scheduleDeleteForContext(ctx, sentMsg1?.message_id, 5000);
      } else {
        const sentMsg2 = await premiumEmojis.replyWithCustomEmoji(ctx, `{alert} ${userLabel}: Предупреждение ${warningCount}/${warnLimit}. Причина: ${reason}`, { '{alert}': 'warning_alert' }, { parse_mode: 'HTML' });
        scheduleDeleteForContext(ctx, sentMsg2?.message_id, 5000);
      }
    } else if (mode === 'mute') {
      // Apply mute
      await applyAutomaticMute(ctx, userId, 24, reason);
    } else if (mode === 'ban') {
      // Apply ban
      const untilDate = Math.floor(Date.now() / 1000) + Math.round(24 * 3600); // 24 hours ban
      try {
        await ctx.telegram.banChatMember(ctx.chat.id, userId, untilDate);
      } catch (error) {
        return;
      }
      database.addPunishment(ctx.chat.id, userId, 'ban', reason, untilDate);
      database.addActivePunishment(ctx.chat.id, userId, 'ban', reason, untilDate);
      schedulePunishmentExpiry({
        chatId: ctx.chat.id,
        userId,
        action: 'ban',
        untilAt: untilDate,
      });
      const userLabel = getMentionText(ctx.from || { id: userId });
      await replyWithAutoDelete(ctx, `${userLabel} забанен на 24ч. Причина: ${reason}`);
    }
  }

  function trackSpamActivity(ctx) {
    if (!isGroupChat(ctx)) {
      return false;
    }

    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;
    if (!userId) {
      return false;
    }

    const now = Date.now();
    const chatTracker = spamActivity.get(chatId) || new Map();
    const userTracker = chatTracker.get(userId) || { messages: [] };
    userTracker.messages = userTracker.messages.filter((item) => now - item.timestamp < 5000);
    userTracker.messages.push({ messageId: ctx.message.message_id, timestamp: now });

    if (userTracker.messages.length >= 5) {
      chatTracker.set(userId, { messages: [] });
      spamActivity.set(chatId, chatTracker);
      return true;
    }

    chatTracker.set(userId, userTracker);
    spamActivity.set(chatId, chatTracker);
    return false;
  }

  async function ensureGroupOwner(ctx) {
    const chatData = ctx.chat || ctx.update?.my_chat_member?.chat;
    if (!chatData) {
      return;
    }

    const chatId = chatData.id;
    const title = chatData.title || String(chatId);
    if (!chatId) {
      return;
    }

    if (!isGroupChat({ chat: chatData })) {
      return;
    }

    let ownerId = null;
    let candidateOwnerId = Number.isFinite(chatData.owner_id) ? chatData.owner_id : null;

    try {
      const chat = await ctx.telegram.getChat(chatId);
      if (chat?.owner_id !== undefined && chat?.owner_id !== null) {
        candidateOwnerId = Number(chat.owner_id);
      }
    } catch (error) {
      // ignore failures retrieving chat info
    }

    try {
      const admins = await ctx.telegram.getChatAdministrators(chatId);
      const creator = admins.find((member) => member.status === 'creator');
      if (creator?.user?.id) {
        ownerId = creator.user.id;
      }
    } catch (error) {
      // ignore failures retrieving chat administrators
    }

    if (!ownerId && Number.isFinite(candidateOwnerId)) {
      ownerId = candidateOwnerId;
    }

    database.ensureGroup(chatId, title, ownerId);
  }

  function getDisplayName(ctx) {
    return ctx.from?.first_name || ctx.from?.username || String(ctx.from?.id);
  }

  async function resolveCommandTarget(ctx, args, usage) {
    const replyTarget = ctx.message.reply_to_message?.from;
    if (replyTarget) {
      return { target: replyTarget, remainingArgs: args.trim() };
    }

    const textMention = ctx.message.entities?.find((entity) => entity.type === 'text_mention' && entity.user);
    if (textMention) {
      return { target: textMention.user, remainingArgs: args.trim() };
    }

    return resolveUsernameTarget(ctx, args, usage, database);
  }

  function startCommand(ctx) {
    const isNew = userService.register(ctx.from.id);
    const status = isNew ? '✨ Рад знакомству' : '👋 С возвращением';
    ctx.reply(`${status}, ${ctx.from.first_name || 'пользователь'}!\n\n✅ Я готов помогать в чате и управлять модерацией.\nИспользуйте /help или !помощь, чтобы увидеть доступные команды.`);
  }

  function getMenuKey(chatId) {
    return String(chatId);
  }

  function getPendingMenuAction(ctx) {
    return pendingMenuActions.get(`${getMenuKey(ctx.chat.id)}:${ctx.from.id}`);
  }

  function setPendingMenuAction(ctx, action) {
    pendingMenuActions.set(`${getMenuKey(ctx.chat.id)}:${ctx.from.id}`, action);
  }

  function clearPendingMenuAction(ctx) {
    pendingMenuActions.delete(`${getMenuKey(ctx.chat.id)}:${ctx.from.id}`);
  }

  function getPendingSettingsAction(ctx) {
    return pendingSettingsActions.get(`${ctx.from.id}:${ctx.chat.id}`);
  }

  function setPendingSettingsAction(ctx, action, groupId = null) {
    pendingSettingsActions.set(`${ctx.from.id}:${ctx.chat.id}`, {
      ...action,
      groupId: Number(groupId ?? action?.groupId ?? ctx.chat.id),
    });
  }

  function clearPendingSettingsAction(ctx) {
    pendingSettingsActions.delete(`${ctx.from.id}:${ctx.chat.id}`);
  }

  function normalizeChannelUsername(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return '';
    }

    let username = raw.replace(/^https?:\/\//i, '');
    username = username.replace(/^www\./i, '');
    username = username.replace(/^t\.me\//i, '');
    username = username.replace(/^telegram\.me\//i, '');
    username = username.replace(/^@/, '');
    username = username.replace(/[?#].*$/, '');
    username = username.replace(/\/+$/, '');
    return username.trim();
  }

  async function resolveChannelChatId(ctx, value) {
    const normalized = normalizeChannelUsername(value);
    if (!normalized) {
      return null;
    }

    const channelId = Number(normalized);
    if (Number.isFinite(channelId)) {
      return channelId;
    }

    try {
      const chat = await ctx.telegram.getChat(`@${normalized}`);
      if (chat && Number.isFinite(Number(chat.id))) {
        return Number(chat.id);
      }
    } catch (error) {
      // try again without the @ prefix
    }

    try {
      const chat = await ctx.telegram.getChat(normalized);
      if (chat && Number.isFinite(Number(chat.id))) {
        return Number(chat.id);
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function isAllowedAnonymousChannel(ctx) {
    if (!ctx || !ctx.chat || !ctx.message) {
      return false;
    }
    const service = activeModerationService || defaultModerationService;
    const message = ctx.message || {};
    const channelId = message.sender_chat?.id || message.forward_from_chat?.id;
    if (!Number.isFinite(Number(channelId))) {
      return false;
    }
    return service.isAllowedAnonymousChannel(ctx.chat.id, channelId);
  }

  function isChannelPostInGroup(ctx) {
    return isGroupChat(ctx) && isChannelPostInGroupMessage(ctx.message);
  }

  function getMenuKeyboard(chatId) {
    return buildMenuKeyboard(chatId);
  }

  function showMentionNotificationMenu(ctx, chatId, source = 'menu') {
    const service = activeModerationService || defaultModerationService;
    const enabled = service.isMentionNotificationsEnabled(chatId);
    const text = [
      '🔔 Уведомление об упоминании',
      '',
      'Когда пользователь упоминает кого-то из уже активных участников, бот может отправить уведомление с упоминанием о ком и в каком чате это произошло.',
      '',
      'Уведомления будут отправляться через @model_cm_bot',
      '',
      `Статус: ${enabled ? 'Включено ✅' : 'Отключено ❌'}`,
    ].join('\n');

    const backCallback = source === 'settings' ? `settings:main:${chatId}` : 'menu:overview';

    const keyboard = {
      inline_keyboard: [
        [
          { text: enabled ? 'Отключить' : 'Включить', callback_data: `menu:mention_toggle:${enabled ? 'off' : 'on'}:${chatId}:${source}` },
        ],
        [{ text: 'Назад', callback_data: backCallback }],
      ],
    };

    if (ctx.callbackQuery) {
      return ctx.editMessageText(text, { reply_markup: keyboard });
    }

    return ctx.reply(text, { reply_markup: keyboard });
  }

  function showMembersManagementMenu(ctx, chatId) {
    const text = [
      '👥 Управление участниками',
      '',
      'Из этого меню вы можете управлять общими действиями над участниками группы.',
      '',
      'Выберите нужное действие ниже.',
    ].join('\n');

    if (ctx.callbackQuery) {
      return ctx.editMessageText(text, { reply_markup: buildMembersManagementKeyboard(chatId) });
    }

    return ctx.reply(text, { reply_markup: buildMembersManagementKeyboard(chatId) });
  }

  function buildMenuButtonsKeyboard(chatId) {
    const rowsData = moderationService.getMenuButtons(chatId);
    const rows = [];

    for (let rowIndex = 0; rowIndex < rowsData.length; rowIndex += 1) {
      const row = rowsData[rowIndex];
      const rowLabel = row.length ? row.map((item) => item.text).join(', ') : 'пусто';
      rows.push([
        { text: `Ряд ${rowIndex + 1}: ${rowLabel}`, callback_data: `menu:row_info:${rowIndex}` },
      ]);
      rows.push([
        { text: 'Добавить кнопку', callback_data: `menu:add_button:${rowIndex}` },
        { text: 'Удалить ряд', callback_data: `menu:remove_row:${rowIndex}` },
      ]);
    }

    rows.push([
      { text: 'Добавить ряд', callback_data: 'menu:add_row' },
      { text: 'Очистить ряды', callback_data: 'menu:clear_buttons' },
    ]);
    rows.push([{ text: 'Назад', callback_data: 'menu:overview' }]);
    return { inline_keyboard: rows };
  }

  function buildMenuRowInfoKeyboard(chatId, rowIndex) {
    const rowsData = moderationService.getMenuButtons(chatId);
    if (rowIndex < 0 || rowIndex >= rowsData.length) {
      return getMenuKeyboard(chatId);
    }

    const row = rowsData[rowIndex];
    const rows = [];
    if (row.length) {
      row.forEach((button, buttonIndex) => {
        rows.push([
          { text: `${button.text} → ${button.url}`, callback_data: 'menu:none' },
          { text: `Удалить ${buttonIndex + 1}`, callback_data: `menu:remove_button:${rowIndex}:${buttonIndex}` },
        ]);
      });
    } else {
      rows.push([{ text: 'Ряд пуст. Добавьте кнопку.', callback_data: 'menu:none' }]);
    }

    rows.push([
      { text: 'Добавить кнопку в ряд', callback_data: `menu:add_button:${rowIndex}` },
      { text: 'Удалить ряд', callback_data: `menu:remove_row:${rowIndex}` },
    ]);
    rows.push([{ text: 'Назад', callback_data: 'menu:buttons' }]);
    return { inline_keyboard: rows };
  }

  function formatMenuOverview(chatId) {
    const text = moderationService.getMenuText(chatId) || 'Текст не задан.';
    const buttons = moderationService.getMenuButtons(chatId);
    const media = moderationService.getMenuMedia(chatId);
    const lines = [
      `📌 Текущий ответ бота на пост канала:\n${text}`,
      '',
      `🔘 Рядов: ${buttons.length}`,
    ];
    if (buttons.length) {
      lines.push('');
      buttons.forEach((row, rowIndex) => {
        const rowText = row.length ? row.map((item) => item.text).join(', ') : 'пусто';
        lines.push(`Ряд ${rowIndex + 1}: ${rowText}`);
      });
    }
    lines.push('');
    lines.push(`🖼️ Медиа: ${media ? media.type : 'не задано'}`);
    return lines.join('\n');
  }

  function getMenuActionInstructions(action) {
    if (action === 'text') {
      return 'Отправьте новый текст для первого сообщения бота.';
    }
    if (action === 'button_add') {
      return 'Отправьте новую кнопку в формате: Название | URL';
    }
    if (action === 'media') {
      return 'Отправьте любое медиа (фото, видео, документ, голос, стикер и т.п.), и я сохраню его в качестве первого медиа-сообщения.';
    }
    return '';
  }
  function getCommandsList() {
    return getCommandSections().flatMap((section) => section.commands);
  }

  function getCommandSections() {
    return [
      {
        id: 'user',
        label: '👤 Пользовательские команды',
        commands: [
          { cmd: 'start', label: '/start' }, { cmd: 'help', label: '/help' },
          { cmd: 'id', label: '/id' }, { cmd: 'about', label: '/about' },
          { cmd: 'whoami', label: '/whoami' }, { cmd: 'stats', label: '/stats' },
          { cmd: 'top', label: '/top' },
        ],
      },
      {
        id: 'moderator',
        label: '👮 Модерские команды',
        commands: [
          { cmd: 'rules', label: '/rules' }, { cmd: 'setrules', label: '/setrules' },
          { cmd: 'setgreeting', label: '/setgreeting' }, { cmd: 'antispam', label: '+антиспам' },
          { cmd: 'antiflood', label: '+антифлуд' }, { cmd: 'antilinks', label: '+ссылки' },
          { cmd: 'warn', label: '/warn' }, { cmd: 'warnings', label: '/warnings' },
          { cmd: 'delwarn', label: '/delwarn' },
          { cmd: 'unwarn', label: '/unwarn' }, { cmd: 'mute', label: '/mute' },
          { cmd: 'delmute', label: '/delmute' },
          { cmd: 'unmute', label: '/unmute' }, { cmd: 'ban', label: '/ban' },
          { cmd: 'delban', label: '/delban' }, { cmd: 'unban', label: '/unban' },
          { cmd: 'banlist', label: '/banlist' }, { cmd: 'mutelist', label: '/mutelist' },
        ],
      },
      {
        id: 'admin',
        label: '👥 Админ-система бота',
        commands: [
          { cmd: 'admins', label: '/admins' }, { cmd: 'addadmin', label: '/addadmin' },
          { cmd: 'removeadmin', label: '/removeadmin' }, { cmd: 'promote', label: '/promote' },
          { cmd: 'demote', label: '/demote' }, { cmd: 'clearhistory', label: '/clearhistory' },
          { cmd: 'admincom', label: '/admincom' },
        ],
      },
      {
        id: 'entertainment',
        label: '🎉 Развлечения',
        commands: [
          { cmd: 'hug', label: '/hug' }, { cmd: 'kiss', label: '/kiss' },
          { cmd: 'slap', label: '/slap' }, { cmd: 'poke', label: '/poke' },
          { cmd: 'coin', label: '/coin' }, { cmd: 'dice', label: '/dice' },
          { cmd: 'fate', label: '/fate' }, { cmd: 'compliment', label: '/compliment' },
          { cmd: 'insult', label: '/insult' }, { cmd: 'ai', label: '/ai' },
        ],
      },
    ];
  }

  function getPermissionEmoji(level) {
    if (level === 'none') return '❌';
    if (level === 'admin') return '👨‍💼';
    return '👥';
  }

  function getPermissionLabel(level) {
    if (level === 'none') return 'Никто';
    if (level === 'admin') return 'Админы';
    return 'Все';
  }

  const COMMANDS_PER_PAGE = 5;

  function getCommandSectionState(chatId, section) {
    const disabled = (activeModerationService || defaultModerationService).getAllCommandDisabled(chatId);
    const disabledCount = section.commands.filter(({ cmd }) => Boolean(disabled[cmd])).length;
    return {
      disabled,
      allDisabled: disabledCount === section.commands.length,
      partiallyDisabled: disabledCount > 0 && disabledCount < section.commands.length,
    };
  }

  function buildCommandSectionsKeyboard(chatId, returnFlag = 'menu') {
    const suffix = returnFlag === 'settings' ? ':settings' : '';
    const rows = getCommandSections().map((section) => {
      const state = getCommandSectionState(chatId, section);
      const status = state.allDisabled ? '❌' : state.partiallyDisabled ? '⚠️' : '✅';
      return [
        { text: `${status} ${section.label}`, callback_data: 'menu:none' },
        { text: state.allDisabled ? 'Включить' : 'Отключить', callback_data: `menu:command_rights:st:${section.id}:${state.allDisabled ? 'enable' : 'disable'}${suffix}` },
      ];
    });
    rows.push([{ text: '🔧 Команды по отдельности', callback_data: `menu:command_rights:commands:0${suffix}` }]);
    rows.push([{ text: 'Назад', callback_data: returnFlag === 'settings' ? `settings:main:${chatId}` : 'menu:overview' }]);
    return { inline_keyboard: rows };
  }

  function buildCommandSectionsText(chatId) {
    const lines = ['📚 Управление разделами', '', 'Раздел можно отключить целиком. Для отдельных команд откройте список команд.', ''];
    getCommandSections().forEach((section) => {
      const state = getCommandSectionState(chatId, section);
      lines.push(`${state.allDisabled ? '❌' : state.partiallyDisabled ? '⚠️' : '✅'} ${section.label}`);
    });
    return lines.join('\n');
  }

  function buildCommandRightsPageText(chatId, pageIndex = 0) {
    const service = activeModerationService || defaultModerationService;
    const commands = getCommandsList();
    const disabled = service.getAllCommandDisabled(chatId);
    const totalPages = Math.max(1, Math.ceil(commands.length / COMMANDS_PER_PAGE));
    const page = Math.max(0, Math.min(pageIndex, totalPages - 1));

    const header = [
      '🔧 Управление командами',
      '',
      'В этом меню можно отключать разделы или отдельные команды бота.',
      '',
      'Статус: ❌ отключено, ✅ включено',
      '',
    ];

    const start = page * COMMANDS_PER_PAGE;
    const pageCommands = commands.slice(start, start + COMMANDS_PER_PAGE);

    pageCommands.forEach(({ cmd, label }) => {
      const isDisabled = Boolean(disabled[cmd]);
      header.push(`${isDisabled ? '❌' : '✅'} ${label}`);
    });

    header.push('');
    header.push(`Страница ${page + 1}/${totalPages}`);
    return header.join('\n');
  }

  function buildCommandRightsPageKeyboard(chatId, pageIndex = 0, returnCallback = `menu:overview`, returnFlag = 'menu') {
    const commands = getCommandsList();
    const service = activeModerationService || defaultModerationService;
    const disabled = service.getAllCommandDisabled(chatId);
    const totalPages = Math.max(1, Math.ceil(commands.length / COMMANDS_PER_PAGE));
    const page = Math.max(0, Math.min(pageIndex, totalPages - 1));

    const start = page * COMMANDS_PER_PAGE;
    const pageCommands = commands.slice(start, start + COMMANDS_PER_PAGE);

    const rows = [];
    const suffix = returnFlag === 'settings' ? ':settings' : '';

    rows.push([{ text: '📚 Управление разделами', callback_data: `menu:command_rights:sections${suffix}` }]);

    pageCommands.forEach((item, idx) => {
      const index = start + idx;
      const isDisabled = Boolean(disabled[item.cmd]);
      const disableButton = { text: isDisabled ? 'Отключить ❌' : 'Отключить', callback_data: `menu:command_rights:disable:${index}${suffix}` };
      const enableButton = { text: isDisabled ? 'Включить' : 'Включить ✅', callback_data: `menu:command_rights:enable:${index}${suffix}` };
      rows.push([{ text: item.label, callback_data: 'menu:none' }, disableButton, enableButton]);
    });

    const nav = [];
    if (page > 0) nav.push({ text: '⬅️ Назад', callback_data: `menu:command_rights:nav:${page - 1}${suffix}` });
    if (page < totalPages - 1) nav.push({ text: 'Вперёд ➡️', callback_data: `menu:command_rights:nav:${page + 1}${suffix}` });

    if (nav.length) rows.push(nav);
    rows.push([{ text: 'Назад', callback_data: returnCallback }]);

    return { inline_keyboard: rows };
  }

  async function showMenuCommandRightsMenu(ctx, chatId, pageIndex = 0, returnCallback = 'menu:overview', returnFlag = 'menu') {
    if (!(await canManageGroupSettings(ctx, chatId))) {
      await ctx.reply('У вас нет прав менять настройки этой группы.');
      return;
    }

    const text = buildCommandRightsPageText(chatId, pageIndex);
    const keyboard = buildCommandRightsPageKeyboard(chatId, pageIndex, returnCallback, returnFlag);
    await safeEditMessageText(ctx, text, { reply_markup: keyboard });
  }

  function detectImageMimeTypeFromBuffer(buffer) {
    if (!buffer || buffer.length < 4) {
      return null;
    }

    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
    if (buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp';

    return null;
  }

  function inferMediaMimeType(fileUrl, fallbackMimeType = null) {
    const normalizedFallback = typeof fallbackMimeType === 'string'
      ? fallbackMimeType.split(';')[0].trim().toLowerCase()
      : '';

    if (normalizedFallback && normalizedFallback !== 'application/octet-stream' && (normalizedFallback.startsWith('image/') || normalizedFallback === 'application/x-tgsticker')) {
      return normalizedFallback === 'application/x-tgsticker' ? 'image/webp' : normalizedFallback;
    }

    const filePath = String(fileUrl || '').split('?')[0].toLowerCase();
    const extMatch = filePath.match(/\.([a-z0-9]+)$/);
    const ext = extMatch ? extMatch[1] : '';

    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'png') return 'image/png';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'bmp') return 'image/bmp';
    if (ext === 'heic' || ext === 'heif') return 'image/heic';

    return normalizedFallback || 'image/jpeg';
  }

  function getMediaPayloadFromMessage(ctx) {
    const message = ctx.message || {};
    if (message.photo && Array.isArray(message.photo) && message.photo.length) {
      return { type: 'photo', fileId: message.photo[message.photo.length - 1].file_id, mimeType: 'image/jpeg' };
    }
    if (message.video && message.video.file_id) {
      return { type: 'video', fileId: message.video.file_id, mimeType: message.video.mime_type && message.video.mime_type.startsWith('video/') ? message.video.mime_type : null };
    }
    if (message.animation && message.animation.file_id) {
      const mimeType = typeof message.animation.mime_type === 'string' && message.animation.mime_type.startsWith('image/')
        ? message.animation.mime_type
        : 'image/gif';
      return { type: 'animation', fileId: message.animation.file_id, mimeType };
    }
    if (message.document && message.document.file_id) {
      const mimeType = typeof message.document.mime_type === 'string'
        ? message.document.mime_type
        : (typeof message.document.file_name === 'string' ? message.document.file_name.toLowerCase() : '');
      const fileName = typeof message.document.file_name === 'string' ? message.document.file_name.toLowerCase() : '';
      const inferred = mimeType && mimeType.startsWith('image/')
        ? mimeType
        : (fileName.endsWith('.png') ? 'image/png' : fileName.endsWith('.jpg') || fileName.endsWith('.jpeg') ? 'image/jpeg' : fileName.endsWith('.webp') ? 'image/webp' : fileName.endsWith('.gif') ? 'image/gif' : null);
      if (inferred) {
        return { type: 'document', fileId: message.document.file_id, mimeType: inferred };
      }
      return null;
    }
    if (message.audio && message.audio.file_id) {
      return { type: 'audio', fileId: message.audio.file_id };
    }
    if (message.voice && message.voice.file_id) {
      return { type: 'voice', fileId: message.voice.file_id };
    }
    if (message.video_note && message.video_note.file_id) {
      return { type: 'video_note', fileId: message.video_note.file_id };
    }
    if (message.sticker && message.sticker.file_id) {
      const mimeType = message.sticker.is_animated ? 'image/gif' : 'image/webp';
      return { type: 'sticker', fileId: message.sticker.file_id, mimeType };
    }
    return null;
  }

  async function getFileBase64DataUrl(fileUrl, fallbackMimeType = null) {
    if (!fileUrl) {
      return null;
    }

    const supportedImageMimeTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

    try {
      const controller = new AbortController();
      const timeoutMs = 15000;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(fileUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'TelegramBot/1.0',
          },
        });
        if (!response.ok) {
          throw new Error(`Telegram file fetch failed with status ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
            const rawMimeType = response.headers.get('content-type') || '';
        const detectedMimeType = detectImageMimeTypeFromBuffer(buffer);
        const inferredMimeType = inferMediaMimeType(fileUrl, fallbackMimeType);

        if (!buffer.length || (!detectedMimeType && (!inferredMimeType || !supportedImageMimeTypes.has(inferredMimeType)))) {
          return null;
        }

        const mimeType = rawMimeType && rawMimeType !== 'application/octet-stream' && rawMimeType.startsWith('image/')
          ? rawMimeType.split(';')[0].trim().toLowerCase()
          : (detectedMimeType || inferredMimeType);

        if (!mimeType || !mimeType.startsWith('image/') || !supportedImageMimeTypes.has(mimeType)) {
          return null;
        }

        if (fallbackMimeType === 'image/webp' && (!detectedMimeType || detectedMimeType !== 'image/webp')) {
          return null;
        }

        if (detectedMimeType && detectedMimeType !== mimeType && mimeType !== 'image/webp' && mimeType !== 'image/gif') {
          return null;
        }

        const base64 = buffer.toString('base64');
        return `data:${mimeType};base64,${base64}`;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      const message = error?.name === 'AbortError'
        ? 'Telegram media download timed out after 15s'
        : error?.message || error;
      console.warn('Failed to fetch Telegram media as base64:', message);
      return null;
    }
  }

  async function analyzeMediaWithAi(ctx, message) {
    const payload = getMediaPayloadFromMessage(ctx);
    if (!payload || !payload.fileId || !payload.mimeType || !payload.mimeType.startsWith('image/')) {
      return false;
    }

    const supportedImageMimeTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
    if (!supportedImageMimeTypes.has(payload.mimeType)) {
      return false;
    }

    let fileUrl = null;
    try {
      const linkResult = await ctx.telegram.getFileLink(payload.fileId);
      if (typeof linkResult === 'string') {
        fileUrl = linkResult;
      } else if (linkResult && typeof linkResult.href === 'string') {
        fileUrl = linkResult.href;
      }
    } catch (error) {
      console.warn('Failed to obtain media file link for AI analysis:', error?.message || error);
      return false;
    }

    if (!fileUrl) {
      return false;
    }

    const dataUrl = await getFileBase64DataUrl(fileUrl, payload.mimeType);
    if (!dataUrl) {
      return shouldFailClosedForMedia(payload, 'invalid image payload', '');
    }

    const mediaTypeLabel = payload.type === 'sticker' ? 'стикер' : payload.type === 'animation' ? 'GIF/анимация' : payload.type === 'document' ? 'документ с изображением' : 'медиа-файл';
    const prompt = [
      {
        type: 'text',
        text: `Оцени этот ${mediaTypeLabel} и ответь только одним словом: «да» или «нет». Если ${mediaTypeLabel} содержит порнографию, откровенно сексуальное, наготу, интимные сцены, сексуальные позы или взрослое (18+) содержание, ответь «да». Если это безопасный контент без обнажённых половых частей, ответь «нет».`,
      },
      {
        type: 'image_url',
        image_url: {
          url: dataUrl,
        },
      },
    ];

    try {
      const result = await ai.requestAi(prompt, {
        apiKey: config.aiApiKey,
        apiBaseUrl: config.aiApiBaseUrl,
        model: config.aiImageModel || config.aiModel,
        enableRealtime: false,
        systemMessage: [
          'Ты — модуль модерации контента для Telegram-бота.',
          'Отвечай только одним словом: да или нет.',
          'Если содержимое содержит эротическую или порнографическую обнажённость, сексуальные позы или интимные сцены, ответь да.',
          'Если содержимое безопасное, обычное или не содержит взрослого контента, ответь нет.',
        ].join(' '),
      });
      const normalized = String(result || '').trim().toLowerCase();
      if (!normalized) {
        console.warn('AI media analysis returned empty response for media:', fileUrl);
        return false;
      }

      const cleaned = normalized
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const firstWord = cleaned.split(' ')[0] || '';
      const positive = ['да', 'yes', 'true', 'adult', 'порно', 'porn', 'эротик', 'откровенн', 'нагота', 'голая', 'сексуал', 'nude', 'nudity', 'sexual', 'sexy'].includes(firstWord)
        || /(?:^|[^\p{L}\p{N}])(да|yes|true|adult|порно|porn|эротик|откровенн|нагота|голая|сексуал|nude|nudity|sexual|sexy)(?:$|[^\p{L}\p{N}])/u.test(cleaned)
        || /(?:^|[^\p{L}\p{N}])(?:содержит|есть|обнаж|сексу)(?:$|[^\p{L}\p{N}])/u.test(cleaned);
      const negative = ['нет', 'no', 'false', 'safe', 'безопасно', 'безопасный'].includes(firstWord)
        || /(?:^|[^\p{L}\p{N}])(нет|no|false|safe|безопасно|безопасный)(?:$|[^\p{L}\p{N}])/u.test(cleaned)
        || /(?:^|[^\p{L}\p{N}])не\s+содержит(?:$|[^\p{L}\p{N}])/u.test(cleaned)
        || /(?:^|[^\p{L}\p{N}])не\s+содержит\s+(взросл|порно|обнаж|сексу)(?:$|[^\p{L}\p{N}])/u.test(cleaned);

      if (!positive && !negative) {
        console.warn('AI media analysis returned unclear response:', normalized, 'for media:', fileUrl);
        if (shouldFailClosedForMedia(payload, '', normalized)) {
          return true;
        }
      }
      return positive && !negative;
    } catch (error) {
      const messageText = String(error?.message || error || '');
      const isUnsupportedStickerPayload = (payload.type === 'sticker' || payload.type === 'animation')
        && /invalid image|not represent a valid image|unsupported image|image data you provided/i.test(messageText);

      if (isUnsupportedStickerPayload) {
        return false;
      }

      console.warn('AI media analysis failed:', messageText);
      if (shouldFailClosedForMedia(payload, messageText, '')) {
        return true;
      }
      // If the failure is due to billing (402 / Insufficient Balance), disable Media AI for this chat
      try {
        const bodyText = error?.body || error?.message || '';
        const isBillingError = (error && error.status === 402) || /Insufficient Balance|Payment Required|402/i.test(String(bodyText));
        if (isBillingError) {
          const service = activeModerationService || defaultModerationService;
          try {
            service.disableMediaAi(ctx.chat.id);
          } catch (e) {
            console.warn('Failed to disable Media AI for chat after billing error:', e?.message || e);
          }

          try {
            await ctx.reply('⚠️ Медиа-модерация ИИ временно отключена в этом чате: недостаточно средств для запросов к AI. Администраторы должны пополнить баланс или отключить функцию.');
          } catch (e) {
            // ignore reply errors
          }
        }
      } catch (e) {
        // ignore unexpected errors in billing handling
      }

      return false;
    }
  }

  async function sendMenuReplyForChannelPost(ctx) {
    const chatId = ctx.chat.id;
    if (!moderationService.getMenuEnabled(chatId)) {
      return null;
    }

    const menuTextPayload = moderationService.getMenuTextPayload(chatId);
    const buttons = moderationService.getMenuButtons(chatId);
    const menuMedia = moderationService.getMenuMedia(chatId);
    const keyboard = buttons.length ? { inline_keyboard: buttons
      .filter((row) => Array.isArray(row) && row.length)
      .map((row) => row.map((item) => ({ text: item.text, url: item.url }))) } : null;
    const { text: formattedText, entities } = moderationService.formatTextWithLinks(menuTextPayload);
    
    // Для первого комментария в topic используем message_thread_id, иначе reply_to_message_id
    const replyOptions = {};
    if (ctx.message.message_thread_id && ctx.message.message_thread_id !== 0) {
      replyOptions.message_thread_id = ctx.message.message_thread_id;
    } else {
      replyOptions.reply_to_message_id = ctx.message.message_id;
    }
    
    if (entities.length) {
      replyOptions.entities = entities;
    }
    if (keyboard) {
      replyOptions.reply_markup = keyboard;
    }

    let sentMessage = null;
    try {
      if (menuMedia && menuMedia.type) {
        const mediaOptions = {
          caption: formattedText,
          caption_entities: entities.length ? entities : undefined,
          reply_markup: replyOptions.reply_markup,
        };
        if (replyOptions.message_thread_id) {
          mediaOptions.message_thread_id = replyOptions.message_thread_id;
        } else {
          mediaOptions.reply_to_message_id = replyOptions.reply_to_message_id;
        }
        
        if (menuMedia.type === 'photo') {
          sentMessage = await ctx.replyWithPhoto(menuMedia.fileId, mediaOptions);
        } else if (menuMedia.type === 'video') {
          sentMessage = await ctx.replyWithVideo(menuMedia.fileId, mediaOptions);
        } else if (menuMedia.type === 'animation') {
          sentMessage = await ctx.replyWithAnimation(menuMedia.fileId, mediaOptions);
        } else if (menuMedia.type === 'document') {
          sentMessage = await ctx.replyWithDocument(menuMedia.fileId, mediaOptions);
        } else if (menuMedia.type === 'audio') {
          sentMessage = await ctx.replyWithAudio(menuMedia.fileId, mediaOptions);
        } else if (menuMedia.type === 'voice') {
          sentMessage = await ctx.replyWithVoice(menuMedia.fileId, mediaOptions);
        } else if (menuMedia.type === 'video_note') {
          sentMessage = await ctx.replyWithVideoNote(menuMedia.fileId, mediaOptions);
        } else if (menuMedia.type === 'sticker') {
          sentMessage = await ctx.replyWithSticker(menuMedia.fileId, mediaOptions);
        }
      }
    } catch (error) {
      console.warn('sendMenuReplyForChannelPost media failed:', error?.message || error);
    }

    if (!sentMessage) {
      sentMessage = await ctx.reply(formattedText, { ...replyOptions, entities: entities.length ? entities : undefined });
    }

    try {
      await ctx.telegram.unpinChatMessage(ctx.chat.id, ctx.message.message_id);
    } catch (error) {
      console.warn('unpinChatMessage failed:', error?.response?.description || error?.message || error);
    }
    return sentMessage;
  }

  async function processPendingSettingsAction(ctx) {
    const pending = getPendingSettingsAction(ctx);
    if (!pending) {
      return false;
    }

    const groupId = Number(pending.groupId || ctx.chat.id);

    if (pending.action === 'settings_link_add' && ctx.message.text) {
      const value = String(ctx.message.text).trim();
      if (!value) {
        await ctx.reply('⚠️ Пустое значение не сохранено.');
        return true;
      }
      if (moderationService.addAllowedLink(groupId, value)) {
        await ctx.reply(`✅ Ссылка/домен добавлен: ${value}`);
      } else {
        await ctx.reply('⚠️ Это значение уже добавлено или некорректно.');
      }
      clearPendingSettingsAction(ctx);
      return true;
    }

    if (pending.action === 'settings_link_remove' && ctx.message.text) {
      const value = String(ctx.message.text).trim();
      if (!value) {
        await ctx.reply('⚠️ Пустое значение не удалено.');
        return true;
      }
      if (moderationService.removeAllowedLink(groupId, value)) {
        await ctx.reply(`✅ Ссылка/домен удалён: ${value}`);
      } else {
        await ctx.reply('⚠️ Такого значения нет в списке.');
      }
      clearPendingSettingsAction(ctx);
      return true;
    }

    if (pending.action === 'settings_forward_add' && ctx.message.text) {
      const value = String(ctx.message.text).trim();
      if (!value) {
        await ctx.reply('⚠️ Пустое значение не сохранено.');
        return true;
      }
      if (moderationService.addAllowedForward(groupId, value)) {
        await ctx.reply(`✅ Исключение добавлено: ${value}`);
        if (pending.category) {
          await showSettingsForwardsCategoryMenu(ctx, groupId, pending.category);
        } else {
          await showSettingsForwardsMenu(ctx, groupId);
        }
      } else {
        await ctx.reply('⚠️ Это значение уже добавлено или некорректно.');
      }
      clearPendingSettingsAction(ctx);
      return true;
    }

    if (pending.action === 'settings_forward_remove' && ctx.message.text) {
      const value = String(ctx.message.text).trim();
      if (!value) {
        await ctx.reply('⚠️ Пустое значение не удалено.');
        return true;
      }
      if (moderationService.removeAllowedForward(groupId, value)) {
        await ctx.reply(`✅ Исключение удалено: ${value}`);
        if (pending.category) {
          await showSettingsForwardsCategoryMenu(ctx, groupId, pending.category);
        } else {
          await showSettingsForwardsMenu(ctx, groupId);
        }
      } else {
        await ctx.reply('⚠️ Такого исключения нет в списке.');
      }
      clearPendingSettingsAction(ctx);
      return true;
    }

    if (pending.action === 'settings_rules_set' && ctx.message.text) {
      moderationService.setRules(groupId, buildTextPayloadFromMessage(ctx));
      await ctx.reply('✅ Правила группы обновлены.');
      clearPendingSettingsAction(ctx);
      return true;
    }

    if (pending.action === 'settings_banword_add' && ctx.message.text) {
      const rawInput = String(ctx.message.text).trim();
      if (!rawInput) {
        await ctx.reply('⚠️ Пустое слово не добавлено.');
        return true;
      }
      
      // Support multi-line and comma-separated input
      const wordsToAdd = rawInput
        .split(/[\n\r,;]+/)  // Split by newlines, carriage returns, commas, or semicolons
        .map(line => line.trim().toLowerCase())
        .filter(word => word.length > 0);
      
      if (wordsToAdd.length === 0) {
        await ctx.reply('⚠️ Пустые слова не добавлены.');
        return true;
      }
      
      const service = activeModerationService || defaultModerationService;
      const added = [];
      const existed = [];
      
      for (const word of wordsToAdd) {
        if (service.addBanWord(groupId, word)) {
          added.push(word);
        } else {
          existed.push(word);
        }
      }
      
      const response = [];
      if (added.length > 0) {
        response.push(`✅ Добавлено ${added.length} слов:\n• ${added.join('\n• ')}`);
      }
      if (existed.length > 0) {
        response.push(`⚠️ Уже в списке (${existed.length} слов):\n• ${existed.join('\n• ')}`);
      }
      await ctx.reply(response.join('\n\n'));
      clearPendingSettingsAction(ctx);
      
      // Show updated word list
      const words = service.getBanWords(groupId);
      const listText = [
        '📋 Список запрещенных слов',
        '',
        words.length ? `Всего слов: ${words.length}\n\n• ${words.join('\n• ')}` : 'Список пуст.',
      ].join('\n');
      await ctx.reply(listText);
      return true;
    }

    if (pending.action === 'settings_banword_remove' && ctx.message.text) {
      const rawInput = String(ctx.message.text).trim();
      if (!rawInput) {
        await ctx.reply('⚠️ Пустое слово не удалено.');
        return true;
      }
      
      // Support multi-line and comma-separated input
      const wordsToRemove = rawInput
        .split(/[\n\r,;]+/)  // Split by newlines, carriage returns, commas, or semicolons
        .map(line => line.trim().toLowerCase())
        .filter(word => word.length > 0);
      
      if (wordsToRemove.length === 0) {
        await ctx.reply('⚠️ Пустые слова не удалены.');
        return true;
      }
      
      const service = activeModerationService || defaultModerationService;
      const removed = [];
      const notFound = [];
      
      for (const word of wordsToRemove) {
        if (service.removeBanWord(groupId, word)) {
          removed.push(word);
        } else {
          notFound.push(word);
        }
      }
      
      const response = [];
      if (removed.length > 0) {
        response.push(`✅ Удалено ${removed.length} слов:\n• ${removed.join('\n• ')}`);
      }
      if (notFound.length > 0) {
        response.push(`⚠️ Не найдено (${notFound.length} слов):\n• ${notFound.join('\n• ')}`);
      }
      await ctx.reply(response.join('\n\n'));
      clearPendingSettingsAction(ctx);
      
      // Show updated word list
      const words = service.getBanWords(groupId);
      const listText = [
        '📋 Список запрещенных слов',
        '',
        words.length ? `Всего слов: ${words.length}\n\n• ${words.join('\n• ')}` : 'Список пуст.',
      ].join('\n');
      await ctx.reply(listText);
      return true;
    }

    if (pending.action === 'settings_message_text' && ctx.message.text) {
      moderationService.setMenuText(groupId, buildTextPayloadFromMessage(ctx));
      await ctx.reply('✅ Текст первого сообщения обновлён.');
      clearPendingSettingsAction(ctx);
      return true;
    }

    if (pending.action === 'settings_agreement_text' && ctx.message.text) {
      moderationService.setAgreementText(groupId, buildTextPayloadFromMessage(ctx));
      await ctx.reply('✅ Текст пользовательского соглашения обновлён.');
      clearPendingSettingsAction(ctx);
      return true;
    }

    if (pending.action === 'settings_agreement_media') {
      const payload = getMediaPayloadFromMessage(ctx);
      if (!payload) {
        await ctx.reply('⚠️ Я не нашёл медиа. Отправьте фото, видео, документ, голос или стикер.');
        return true;
      }
      moderationService.setAgreementMedia(groupId, payload);
      await ctx.reply(`✅ Медиа для соглашения сохранено как ${payload.type}.`);
      clearPendingSettingsAction(ctx);
      return true;
    }

    if (pending.action === 'settings_streaks_label' && ctx.message.text) {
      const value = String(ctx.message.text).trim();
      if (!value) {
        await ctx.reply('⚠️ Пустое название не сохранено.');
        return true;
      }
      moderationService.setStreaksLabel(groupId, value);
      await ctx.reply(`✅ Название системы изменено на: ${value}`);
      clearPendingSettingsAction(ctx);
      return true;
    }

    if (pending.action === 'settings_anonymous_channel_add' && ctx.message.text) {
      const value = String(ctx.message.text).trim();
      if (!value) {
        await ctx.reply('⚠️ Пустое значение не сохранено.');
        return true;
      }
      const resolvedChatId = await resolveChannelChatId(ctx, value);
      if (!resolvedChatId) {
        await ctx.reply('⚠️ Не удалось определить канал. Укажите @username, t.me/username или numeric ID.');
        return true;
      }
      if (moderationService.addAllowedAnonymousChannel(groupId, resolvedChatId)) {
        await ctx.reply(`✅ Канал добавлен в исключения: ${resolvedChatId}`);
      } else {
        await ctx.reply('⚠️ Этот канал уже есть в списке или ID некорректен.');
      }
      clearPendingSettingsAction(ctx);
      return true;
    }

    if (pending.action === 'settings_anonymous_channel_remove' && ctx.message.text) {
      const value = String(ctx.message.text).trim();
      if (!value) {
        await ctx.reply('⚠️ Пустое значение не удалено.');
        return true;
      }
      const resolvedChatId = await resolveChannelChatId(ctx, value);
      if (!resolvedChatId) {
        await ctx.reply('⚠️ Не удалось определить канал. Укажите @username, t.me/username или numeric ID.');
        return true;
      }
      if (moderationService.removeAllowedAnonymousChannel(groupId, resolvedChatId)) {
        await ctx.reply(`✅ Канал удалён из исключений: ${resolvedChatId}`);
      } else {
        await ctx.reply('⚠️ Такого канала нет в списке.');
      }
      clearPendingSettingsAction(ctx);
      return true;
    }

    if (pending.action === 'settings_message_button_add' && ctx.message.text) {
      const [title, url] = String(ctx.message.text).split('|').map((part) => part.trim());
      if (!title || !url) {
        await ctx.reply('⚠️ Неверный формат. Отправьте в формате: Название | URL');
        return true;
      }
      if (!moderationService.addMenuButton(groupId, title, url, typeof pending.rowIndex === 'number' ? pending.rowIndex : null)) {
        await ctx.reply('⚠️ Не удалось добавить кнопку.');
      } else {
        await ctx.reply(`✅ Кнопка добавлена: ${title} → ${url}`);
      }
      clearPendingSettingsAction(ctx);
      return true;
    }

    if (pending.action === 'settings_message_media') {
      const payload = getMediaPayloadFromMessage(ctx);
      if (!payload) {
        await ctx.reply('⚠️ Я не нашёл медиа. Отправьте фото, видео, документ, голос или стикер.');
        return true;
      }
      moderationService.setMenuMedia(groupId, payload);
      await ctx.reply(`✅ Медиа сохранено как ${payload.type}.`);
      clearPendingSettingsAction(ctx);
      return true;
    }

    if (pending.action === 'admin_report_write') {
      const reportId = String(pending.reportId || '');
      const report = adminReports.get(reportId);
      if (!report) {
        await ctx.reply('⚠️ Жалоба не найдена или уже обработана.');
        clearPendingSettingsAction(ctx);
        return true;
      }

      const text = (ctx.message && (ctx.message.text || '')).trim();
      if (!text) {
        await ctx.reply('⚠️ Пустой отчёт не отправлен. Напишите текст отчёта.');
        return true;
      }

      const acceptor = report.acceptedBy || { id: ctx.from.id, username: ctx.from.username, first_name: ctx.from.first_name };
      const finalText = formatAdminReportText(report, acceptor) + '\n\n📝 Отчёт модератора:\n' + text;

      // update all notification messages
      try {
        if (Array.isArray(report.notifications)) {
          for (const note of report.notifications) {
            try {
              await ctx.telegram.editMessageText(note.chatId, note.messageId, null, finalText);
            } catch (err) {
              // ignore per-message errors
            }
          }
        }
      } catch (err) {
        // ignore
      }

      // delete moderator's message containing the report
      try {
        if (ctx.message && ctx.message.message_id) {
          await ctx.deleteMessage(ctx.message.message_id);
        }
      } catch (err) {
        // ignore deletion errors
      }

      // delete prompt message that asked the moderator to write the report
      try {
        const promptMessageId = Number(pending.promptMessageId || 0);
        if (Number.isFinite(promptMessageId) && promptMessageId > 0) {
          await ctx.deleteMessage(promptMessageId);
        }
      } catch (err) {
        // ignore deletion errors
      }

      // remove stored report
      adminReports.delete(reportId);
      clearPendingSettingsAction(ctx);
      // optionally confirm in the admin chat
      try {
        const confirmation = await ctx.reply('✅ Отчёт добавлен в уведомление.');
        await ctx.deleteMessage(confirmation.message_id);
      } catch (err) {
        // ignore
      }
      return true;
    }

    if (pending.action === 'settings_warn_duration_custom' && ctx.message.text) {
      const input = String(ctx.message.text).trim().toLowerCase();
      const groupId = Number(pending.groupId || ctx.chat.id);
      const service = activeModerationService || defaultModerationService;

      // Parse custom duration format: 1ч, 2д, 1мес, 1год, etc.
      const match = input.match(/^(\d+(?:\.\d+)?)\s*(ч|час|часа|часов|д|день|дня|дней|мес|месяц|месяца|месяцев|г|год|года|лет)?$/i);
      if (!match) {
        await replyWithAutoDelete(ctx, '⚠️ Неверный формат. Выполните по шаблону: 1ч, 2д, 1мес, 1год');
        return true;
      }

      const value = Number(match[1]);
      const unit = (match[2] || 'ч').toLowerCase();
      let durationHours = 0;

      if (['ч', 'час', 'часа', 'часов'].includes(unit)) {
        durationHours = value;
      } else if (['д', 'день', 'дня', 'дней'].includes(unit)) {
        durationHours = value * 24;
      } else if (['мес', 'месяц', 'месяца', 'месяцев'].includes(unit)) {
        durationHours = value * 24 * 30;
      } else if (['г', 'год', 'года', 'лет'].includes(unit)) {
        durationHours = value * 24 * 365;
      }

      if (durationHours <= 0) {
        await replyWithAutoDelete(ctx, '⚠️ Время должно быть положительным.');
        return true;
      }

      service.setWarnBlockDuration(groupId, durationHours);
      await replyWithAutoDelete(ctx, `✅ Время бана установлено: ${durationHours}ч`);
      clearPendingSettingsAction(ctx);
      return true;
    }

    return false;
  }

  async function processPendingMenuAction(ctx) {
    const pending = getPendingMenuAction(ctx);
    if (!pending) {
      return false;
    }

    if (pending.action === 'text' && ctx.message.text) {
      moderationService.setMenuText(ctx.chat.id, buildTextPayloadFromMessage(ctx));
      await ctx.reply('✅ Текст первого сообщения обновлён.');
      clearPendingMenuAction(ctx);
      return true;
    }

    if (pending.action === 'button_add' && ctx.message.text) {
      const [title, url] = ctx.message.text.split('|').map((part) => part.trim());
      const rowIndex = typeof pending.rowIndex === 'number' ? pending.rowIndex : null;
      if (!title || !url) {
        await ctx.reply('⚠️ Неверный формат. Отправьте в формате: Название | URL');
        return true;
      }
      if (!moderationService.addMenuButton(ctx.chat.id, title, url, rowIndex)) {
        await ctx.reply('⚠️ Не удалось добавить кнопку. Проверьте ряд и формат.');
      } else {
        await ctx.reply(`✅ Кнопка добавлена: ${title} → ${url}`);
      }
      clearPendingMenuAction(ctx);
      return true;
    }

    if (pending.action === 'media') {
      const payload = getMediaPayloadFromMessage(ctx);
      if (!payload) {
        await ctx.reply('⚠️ Я не нашёл медиа. Отправьте фото, видео, документ, голос или стикер.');
        return true;
      }
      moderationService.setMenuMedia(ctx.chat.id, payload);
      await ctx.reply(`✅ Медиа сохранено как ${payload.type}.`);
      clearPendingMenuAction(ctx);
      return true;
    }

    if (pending.action === 'bot_message' && ctx.message.text) {
      const groupId = pending.groupId || ctx.chat.id;
      try {
        await ctx.telegram.sendMessage(groupId, ctx.message.text, {
          entities: ctx.message.entities || [],
          parse_mode: undefined,
        });
      } catch (error) {
        await ctx.reply(`⚠️ Ошибка при отправке сообщения: ${error?.message || error}`);
      }
      // Delete the command message
      try {
        await ctx.deleteMessage();
      } catch (error) {
        // Ignore if message cannot be deleted
      }
      clearPendingMenuAction(ctx);
      return true;
    }

    return false;
  }

  function menuCommand(ctx) {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const chatId = Number(ctx.chat?.id || 0);
    if (!chatId) {
      ctx.reply('⚠️ Не удалось определить группу.');
      return;
    }

    ctx.reply(formatMenuOverview(chatId), { reply_markup: getMenuKeyboard(chatId) });
  }

  async function botCommand(ctx) {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const chatId = Number(ctx.chat?.id || 0);
    if (!chatId) {
      await ctx.reply('⚠️ Не удалось определить группу.');
      return;
    }

    const args = ctx.message.text.replace(/^\/bot(?:@[\w_]+)?\s*/i, '').trim();
    if (!args) {
      await ctx.reply('📝 Используйте: /bot <сообщение>\n\nПример: /bot Привет, участники! 👋');
      return;
    }

    try {
      await ctx.telegram.sendMessage(chatId, args, {
        entities: ctx.message.entities?.filter(e => {
          const startOffset = e.offset - 5; // "/bot " is 5 characters
          return startOffset >= 0;
        }).map(e => ({
          ...e,
          offset: e.offset - 5,
        })) || [],
        parse_mode: undefined,
      });
    } catch (error) {
      await ctx.reply(`⚠️ Ошибка при отправке сообщения: ${error?.message || error}`);
      return;
    }
    // Delete the command message
    try {
      await ctx.deleteMessage();
    } catch (error) {
      // Ignore if message cannot be deleted
    }
  }

  function getHelpPages() {
    return [
      [
        '📋 СПРАВКА ПО КОМАНДАМ',
        '',
        '👤 ПОЛЬЗОВАТЕЛЬСКИЕ КОМАНДЫ',
        '/start, !начало - начать работу',
        '/help, !помощь - показать эту справку',
        '/id, !айди - показать ваши ID',
        '/about, !информация - информация о боте',
        '/whoami, !кто я - забавное описание вас',
        '/stats, !статистика - личная статистика (сообщения, серия дней, активность)',
        '/top, !топ - топ по сообщениям (с бейджами серии)',
      ].join('\n'),
      [
        '📋 СПРАВКА ПО КОМАНДАМ',
        '',
        '👮 МОДЕРСКИЕ КОМАНДЫ',
        '/rules, !правила - показать правила чата',
        '/setrules, !установить правила <текст> - установить правила',
        '/setgreeting, !установить приветствие <текст> - установить приветствие',
        '+антиспам - включить антиспам',
        '-антиспам - выключить антиспам',
        '+антифлуд - включить антифлуд',
        '-антифлуд - выключить антифлуд',
        '+ссылки - включить антиссылки',
        '-ссылки - выключить антиссылки',
        '/menu - открыть настройки группы (капча, ссылки, антиспам, первый комментарий, серия)',
        '  • 🛡️ Капча - включить капчу при входе',
        '  • 🔗 Ссылки - управлять разрешёнными ссылками',
        '  • 🛡️ Антиспам - антиспам, антифлуд, антиссылки',
        '  • 💬 Первый комментарий - текст, кнопки, медиа',
        '  • 🔥 Серия - включить/выключить систему серий, изменить название',
        '/warn, !предупреждение @юз - выдать предупреждение',
        '/delwarn, !delwarn <причина> - выдать предупреждение и удалить сообщение (только ответом)',
        '/warnings, !варны [@юз] - показать варны пользователя',
        '/unwarn, !снять предупреждение @юз - снять предупреждения',
        '/mute, !мут @юз <время> <причина> - ограничить сообщения',
        '/delmute, !delmute <время> <причина> - выдать mute и удалить сообщение (только ответом)',
        '/unmute, !размут - снять ограничение',
        '/ban, !бан <время> <причина> - заблокировать пользователя',
        '/delban, !delban <время> <причина> - заблокировать и удалить сообщение (только ответом)',
        '/unban, !разбан - разблокировать пользователя',
        '/banlist, !баны [страница] - список активных банов',
        '/mutelist, !муты [страница] - список активных мутов',
          '/admins, !админы - список администраторов бота',
        '/addadmin @юз, !добавить админа @юз - назначить админа бота',
          '/removeadmin @юз, !снять админа @юз - снять вспомогательного администратора бота',
          '/promote @юз [уровень], !повышение @юз [уровень] - повысить администратора (если уровень не указан, повышает на 1)',
          '/demote @юз [уровень], !разжалование @юз [уровень] - понизить администратора (если уровень не указан, понижает на 1)',
          '',
          '🛡️ КОМАНДЫ НАКАЗАНИЙ',
          '/admincom - список команд наказаний и примеры их использования',
      ].join('\n'),
      [
        '📋 Система уровней администраторов',
        '',
        'Уровни (1 = наивысший):',
        '1 — Главный админ (владелец группы). Это главный админ и он всегда имеет наивысший приоритет.',
        '2 — Ведущий админ. Доступ ко всем командам модерации и приоритет выше остальных администраторов.',
        '3 — Старший админ. Может мутить и выдавать предупреждения, а также банить, но имеет более высокий приоритет, чем средний и младший админ.',
        '4 — Средний админ. Может мутить, выдавать предупреждения и банить.',
        '5 — Младший админ. Может только мутить и выдавать предупреждения.',
        '',
        'Команды управления админами:',
        '/admins — показать админов по уровням',
        '/addadmin @user [уровень] — назначить админа (по умолчанию уровень 5)',
        '/removeadmin @user — снять админа',
        '/promote @user [уровень] — повысить администратора (без уровня повышает на 1). Нельзя повысить до уровня не ниже вашего.',
        '/demote @user [уровень] — понизить администратора (без уровня понижает на 1).',
        '',
        'Правила:',
        '- Нельзя наказывать админов выше себя. При попытке будет сообщение: "Ты не можешь наказывать админов выше себя".',
        '- Главный админ защищён: его нельзя снять/изменить другими администраторами.',
        '',
        'Примеры:',
        '/addadmin @ivan 4 — назначить @ivan админом уровня 4 (средний)',
        '/promote @petya — повысить @petya на один уровень',
      ].join('\n'),
      [
        '📋 СПРАВКА ПО КОМАНДАМ',
        '',
        '🎉 РАЗВЛЕЧЕНИЯ',
        '/hug @юз, !обнять @юз - обнять пользователя',
        '/kiss @юз, !поцеловать @юз - поцеловать пользователя',
        '/slap @юз, !шлёпнуть @юз - шлёпнуть пользователя',
        '/poke @юз, !тыкнуть @юз - ткнуть пользователя',
        '/coin, !монетка - подбросить монетку',
        '/dice, !кубик - бросить кубик',
        '/fate, !вопрос - спросить судьбу',
        '/compliment, !комплимент - получить комплимент',
        '/insult, !инсульт - получить приятную шутку',
        '/ai <текст> - спросить AI и получить ответ',
        '',
        'Используйте русские команды с ! и английские с /',
      ].join('\n'),
      [
        '🔥 СИСТЕМА СЕРИЙ (STREAK)',
        '',
        'Система серий отслеживает ежедневную активность пользователей в группе.',
        '',
        'КАК ЭТО РАБОТАЕТ:',
        '• Каждый день, когда пользователь пишет сообщение, фиксируется его активность',
        '• Серия считается как количество ПОСЛЕДОВАТЕЛЬНЫХ дней активности',
        '• Если пользователь не пишет день - серия сбивается',
        '• Бейджи появляются в /stats и /top с разными уровнями:',
        '  1-19 дней — уровень 1',
        '  20-49 дней — уровень 2',
        '  50-99 дней — уровень 3',
        '  100-499 дней — уровень 4',
        '  500+ дней — уровень 5',
        '',
        'УПРАВЛЕНИЕ СИСТЕМОЙ:',
        '• Администратор может включить/выключить систему серий через /menu',
        '• Можно изменить название раздела (Серия, Стриик, Рейтинг, Стаж и т.д.)',
        '• По умолчанию система включена для всех новых групп',
        '',
        'КОМАНДЫ:',
        '/stats - посмотреть свою активность и текущую серию',
        '/top - посмотреть топ по активности с бейджами серий',
      ].join('\n'),
    ];
  }

  function buildHelpPage(pageIndex) {
    const pages = getHelpPages();
    const page = Math.max(0, Math.min(pageIndex, pages.length - 1));
    const buttons = [];
    if (page > 0) {
      buttons.push({ text: '⬅️ Назад', callback_data: `help:${page - 1}` });
    }
    if (page < pages.length - 1) {
      buttons.push({ text: 'Вперёд ➡️', callback_data: `help:${page + 1}` });
    }

    const header = [
      '📘 Справка по боту',
      '',
      `📄 Раздел ${page + 1}/${pages.length}`,
      '',
    ].join('\n');

    return {
      text: `${header}${pages[page]}`,
      reply_markup: {
        inline_keyboard: [buttons],
      },
    };
  }

  async function helpCommand(ctx) {
    const text = (ctx.message && ctx.message.text) ? String(ctx.message.text).trim() : '';
    const parts = text.split(/\s+/).filter(Boolean);
    let pageIndex = 0;
    if (parts.length > 1) {
      const arg = parts[1].toLowerCase();
      if (arg === 'admins' || arg === 'админы' || arg === 'admins:') {
        // admins page is index 2 in the pages array
        pageIndex = 2;
      } else {
        const parsed = Number(arg);
        if (Number.isFinite(parsed)) {
          pageIndex = Math.max(0, parsed - 1);
        }
      }
    }

    const helpPage = buildHelpPage(pageIndex);
    await ctx.reply(helpPage.text, { reply_markup: helpPage.reply_markup });
  }

  function idCommand(ctx) {
    ctx.reply(`Ваш Telegram ID: ${ctx.from.id}\nID чата: ${ctx.chat.id}`);
  }

  async function adminPunishmentCommandsCommand(ctx) {
    ensureGroup(ctx);
    scheduleDeleteForContext(ctx, ctx.message?.message_id);
    if (!await canUseAdminPunishmentCommands(ctx)) {
      await replyWithAutoDelete(ctx, 'Эта команда доступна только модераторам.');
      return;
    }

    const sentMessage = await ctx.reply([
      '🛡️ Команды наказаний для модераторов',
      '',
      '⚠️ Предупреждения:',
      '/warn @юз причина, !предупреждение @юз причина — выдать предупреждение.',
      '/delwarn причина, !delwarn причина — ответьте на сообщение: выдать предупреждение и удалить его.',
      '/warnings [@юз], !варны [@юз] — посмотреть количество предупреждений.',
      '/unwarn @юз, !снять предупреждение @юз — снять предупреждения.',
      '',
      '🔇 Ограничения:',
      '/mute @юз <время> <причина>, !мут @юз <время> <причина> — ограничить сообщения.',
      '/delmute <время> <причина>, !delmute <время> <причина> — ответьте на сообщение: выдать mute и удалить его.',
      '/unmute @юз, !размут @юз — снять ограничение.',
      '',
      '⛔ Блокировки:',
      '/ban @юз <время> <причина>, !бан @юз <время> <причина> — заблокировать пользователя.',
      '/delban <время> <причина>, !delban <время> <причина> — ответьте на сообщение: заблокировать автора и удалить его.',
      '/unban @юз, !разбан @юз — разблокировать пользователя.',
      '/banlist [страница], !баны [страница] — список активных банов.',
      '/mutelist [страница], !муты [страница] — список активных мутов.',
      '/clearhistory @юз — очистить историю наказаний пользователя (для старших уровней).',
      '',
      'Если срок и причина не указаны, наказание действует без срока, а причина указывается как «Без причины».',
      'Для /delwarn, /delmute и /delban обязательно нужно ответить на сообщение пользователя.',
      '',
      'Уровни: 1–4 могут банить, 1–5 могут выдавать mute и предупреждения.',
    ].join('\n'), {
      reply_markup: {
        inline_keyboard: [[{ text: 'Закрыть', callback_data: 'admincom:close' }]],
      },
    });

    await deleteMessageSafely(ctx, ctx.message?.message_id);
    return sentMessage;
  }

  function aboutCommand(ctx) {
    ctx.reply(`${config.botName}\nПолноценный бот на Node.js.`);
  }

  function whoamiCommand(ctx) {
    ctx.reply(`${ctx.from.first_name || 'Пользователь'}, ${getFunnyDescription()}`);
  }

  function funCommand(ctx, kind) {
    const reply = buildFunReply(kind);
    ctx.reply(reply);
  }

  async function handlePrivateAIMessages(ctx, text) {
    const prompt = `Пользователь пишет: "${text}". Отвечай как помощник, который помогает написать команду для бота и подсказывает, если текст не является корректной командой.`;
    try {
      const content = await ai.requestAi(prompt, {
        apiKey: config.aiApiKey,
        apiBaseUrl: config.aiApiBaseUrl,
        model: config.aiModel,
        weatherLocation: config.weatherLocation,
      });
      if (content) {
        ctx.reply(content);
      } else {
        ctx.reply('Я получил ваш текст, но не смог сформировать ответ. Попробуйте переформулировать.');
      }
    } catch (error) {
      console.error('AI request failed:', error?.message || error);
      if (error && error.status === 401) {
        ctx.reply('AI error: unauthorized (401). Проверьте ключ в .env и AI_API_BASE_URL.');
        return;
      }
      if (error && error.message === 'no_api_key') {
        ctx.reply('AI ключ не найден. Установите OPENROUTER_API_KEY или AI_API_KEY в .env.');
        return;
      }
      ctx.reply('AI error: запрос не выполнен. Проверьте ключ и настройки AI в .env.');
    }
  }

  async function aiCommand(ctx, prompt) {
    const trimmedPrompt = String(prompt || '').trim();
    if (!trimmedPrompt) {
      ctx.reply('Напиши запрос после /ai. Например: /ai расскажи анекдот.');
      return;
    }

    if (!config.aiApiKey) {
      ctx.reply('AI недоступен: OPENROUTER_API_KEY или AI_API_KEY должен быть задан в файле .env.');
      return;
    }

    try {
      const content = await ai.requestAi(trimmedPrompt, { apiKey: config.aiApiKey, apiBaseUrl: config.aiApiBaseUrl, model: config.aiModel, weatherLocation: config.weatherLocation });

      if (content) {
        ctx.reply(content);
        return;
      }

      ctx.reply('AI вернул пустой ответ. Попробуйте сформулировать запрос иначе.');
    } catch (error) {
      console.error('AI request failed:', error?.message || error);

      if (error && error.status === 401) {
        ctx.reply('AI error: unauthorized (401). Проверьте ключ в .env и AI_API_BASE_URL.');
        return;
      }

      if (error && error.message === 'no_api_key') {
        ctx.reply('AI ключ не найден. Установите OPENROUTER_API_KEY или AI_API_KEY в .env.');
        return;
      }

      ctx.reply('AI error: запрос не выполнен. Проверьте ключ и настройки AI в .env.');
    }
  }

  function sendRoleplayResponse(ctx, verb, target, emoji) {
    const fromText = getMentionText(ctx.from);
    const targetText = getMentionText(target);
    ctx.reply(`${fromText} ${verb} ${targetText} ${emoji}`);
  }

  async function roleplayCommand(ctx, args, action) {
    const target = await resolveRoleplayTarget(ctx, args, `/${action} @юз`);
    if (!target) {
      return;
    }

    switch (action) {
      case 'hug':
        sendRoleplayResponse(ctx, 'обнял', target, '🤗');
        break;
      case 'kiss':
        sendRoleplayResponse(ctx, 'поцеловал', target, '😘');
        break;
      case 'slap':
        sendRoleplayResponse(ctx, 'шлёпнул', target, '👋');
        break;
      case 'poke':
        sendRoleplayResponse(ctx, 'тыкнул', target, '👉');
        break;
      case 'fuck':
        sendRoleplayResponse(ctx, 'выебал', target, '🔞');
        break;
      case 'rape':
        sendRoleplayResponse(ctx, 'трахнул', target, '🔞');
        break;
      case 'beat':
        sendRoleplayResponse(ctx, 'уебал', target, '💢');
        break;
      case 'kill':
        sendRoleplayResponse(ctx, 'убил', target, '☠️');
        break;
      case 'bite':
        sendRoleplayResponse(ctx, 'укусил', target, '🦷');
        break;
      case 'lick':
        sendRoleplayResponse(ctx, 'лизнул', target, '👅');
        break;
      case 'lickup':
        sendRoleplayResponse(ctx, 'отлизал', target, '👅');
        break;
      default:
        ctx.reply('Неизвестное действие.');
        break;
    }
  }

  async function resolveRoleplayTarget(ctx, args, usage) {
    const targetData = await resolveCommandTarget(ctx, args, usage);
    return targetData?.target || null;
  }

  function buildActivityChartSvg(activity = []) {
    const safeActivity = Array.isArray(activity) && activity.length ? activity : [];
    const width = 360;
    const height = 140;
    const paddingX = 24;
    const paddingY = 18;
    const chartWidth = width - paddingX * 2;
    const chartHeight = height - paddingY * 2;
    const maxValue = Math.max(1, ...safeActivity.map((item) => Number(item.count || 0)));

    const points = safeActivity.map((item, index) => {
      const x = paddingX + (chartWidth / Math.max(1, safeActivity.length - 1)) * index;
      const value = Number(item.count || 0);
      const y = paddingY + chartHeight - (value / maxValue) * chartHeight;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    const polyline = points.length ? `M ${points.join(' L ')}` : '';
    const labels = safeActivity.map((item, index) => {
      const label = item.day ? item.day.slice(5) : `${index + 1}`;
      const x = paddingX + (chartWidth / Math.max(1, safeActivity.length - 1)) * index;
      return `<text x="${x.toFixed(1)}" y="${height - 4}" font-size="10" text-anchor="middle" fill="#6b7280">${label}</text>`;
    }).join('');

    const bars = safeActivity.map((item, index) => {
      const value = Number(item.count || 0);
      const x = paddingX + 8 + (chartWidth / Math.max(1, safeActivity.length)) * index;
      const barWidth = Math.max(10, (chartWidth / Math.max(1, safeActivity.length)) - 10);
      const heightValue = (value / maxValue) * (chartHeight * 0.7);
      const y = paddingY + chartHeight - heightValue;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${heightValue.toFixed(1)}" rx="3" fill="#3b82f6" />`;
    }).join('');

    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n  <rect x="0" y="0" width="${width}" height="${height}" rx="12" fill="#0f172a" />\n  <line x1="${paddingX}" y1="${height - paddingY}" x2="${width - paddingX}" y2="${height - paddingY}" stroke="#475569" stroke-width="1" />\n  <line x1="${paddingX}" y1="${paddingY}" x2="${paddingX}" y2="${height - paddingY}" stroke="#475569" stroke-width="1" />\n  ${polyline ? `<path d="${polyline}" fill="none" stroke="#60a5fa" stroke-width="2.5" />` : ''}\n  ${bars}\n  ${labels}\n</svg>`;
  }

  async function buildActivityChartPng(activity = []) {
    const svg = buildActivityChartSvg(activity);
    return sharp(Buffer.from(svg, 'utf8')).png().toBuffer();
  }

  function escapeCaptionText(value) {
    const text = value === null || value === undefined ? '' : String(value);
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/\r?\n/g, ' ');
  }

  async function statsCommand(ctx, args) {
    ensureGroup(ctx);

    let targetUser = ctx.message.reply_to_message?.from || ctx.from;
    if (args && args.trim()) {
      const targetData = await resolveCommandTarget(ctx, args, '/stats @юз');
      if (!targetData) {
        return;
      }
      targetUser = targetData.target;
    }

    const profile = database.getUserProfile(ctx.chat.id, targetUser.id);
    const activity = database.getUserActivity(ctx.chat.id, targetUser.id, 7);
    const moderationService = activeModerationService || defaultModerationService;
    const streaksEnabled = moderationService.isStreaksEnabled(ctx.chat.id);
    const streakLabel = moderationService.getStreaksLabel(ctx.chat.id);
    const username = profile.username || getMentionText(targetUser);
    const punishments = profile.punishments.length
      ? profile.punishments.map((item) => `${item.action}${item.reason ? `: ${item.reason}` : ''}`).join(', ')
      : 'нет';
    const description = profile.description ? profile.description : 'нет';
    const topLabel = profile.topPosition ? `${profile.topPosition} место` : 'не в топе';
    const streakBadgeText = premiumEmojis.getStreakBadge(profile.streak);
    const streakInfo = premiumEmojis.getStreakBadgeInfo(profile.streak);
    const streakPrefix = `${streakLabel}: `;
    const streakLine = streaksEnabled ? `${streakPrefix}${streakBadgeText}` : null;
    const lastSeenLabel = profile.lastSeenAt ? new Date(profile.lastSeenAt).toLocaleString('ru-RU') : 'неизвестно';
    const chartSvg = buildActivityChartSvg(activity);
    const actorLevel = database.isPrimaryBotAdmin(ctx.chat.id, ctx.from.id)
      ? 1
      : database.getBotAdminLevel(ctx.chat.id, ctx.from.id);
    const canResetPunishmentHistory = Number.isFinite(Number(actorLevel)) && Number(actorLevel) <= 2;
    const captionLines = [
      `📊 Анкета пользователя ${escapeCaptionText(username)}`,
      `Имя: ${escapeCaptionText(profile.displayName || targetUser.first_name || targetUser.username || targetUser.id)}`,
      `Описание: ${escapeCaptionText(description)}`,
      `Наказания: ${escapeCaptionText(punishments)}`,
      `Сообщений: ${escapeCaptionText(profile.messageCount)}`,
      ...(streakLine ? [streakLine] : []),
      `Место в топе: ${escapeCaptionText(topLabel)}`,
      `Последний вход: ${escapeCaptionText(lastSeenLabel)}`,
      '',
      'Активность за последние 7 дней',
    ];
    const captionText = captionLines.join('\n');
    const captionEntities = [];
    const extraReplyMarkup = canResetPunishmentHistory
      ? { inline_keyboard: [[{ text: 'Сбросить историю наказаний', callback_data: `stats:clear_history:${ctx.chat.id}:${targetUser.id}` }]] }
      : undefined;

    if (streaksEnabled && streakInfo && streakBadgeText && streakLine) {
      const badgeString = String(streakInfo.fallback);
      const lineStart = captionText.indexOf(streakLine);
      const badgeStart = captionText.indexOf(badgeString, lineStart >= 0 ? lineStart : 0);
      if (badgeStart >= 0) {
        captionEntities.push({
          type: 'custom_emoji',
          offset: badgeStart,
          length: badgeString.length,
          custom_emoji_id: streakInfo.id,
        });
      }
    }

    try {
      const chartPng = await buildActivityChartPng(activity);
      await ctx.replyWithPhoto({ source: chartPng }, {
        caption: captionText,
        caption_entities: captionEntities.length ? captionEntities : undefined,
        reply_markup: extraReplyMarkup,
      });
    } catch (error) {
      console.error('Failed to convert chart to PNG:', error);
      await ctx.replyWithDocument({ source: Buffer.from(chartSvg, 'utf8'), filename: 'stats.svg' }, {
        caption: captionText,
        caption_entities: captionEntities.length ? captionEntities : undefined,
        reply_markup: extraReplyMarkup,
      });
    }
  }

  function topCommand(ctx) {
    if (!isGroupChat(ctx)) {
      ctx.reply('Статистика доступна только в групповых чатах.');
      return;
    }
    ensureGroup(ctx);
    const top = database.topMessages(ctx.chat.id, 10);
    if (!top.length) {
      ctx.reply('Пока нет статистики сообщений в этой группе.');
      return;
    }
    const moderationService = activeModerationService || defaultModerationService;
    const streaksEnabled = moderationService.isStreaksEnabled(ctx.chat.id);
    const streakLabel = moderationService.getStreaksLabel(ctx.chat.id);
    const lines = top.map((item, index) => {
      const label = item.displayName || item.userId;
      const badge = streaksEnabled ? premiumEmojis.getStreakBadge(item.streak || 0) : '';
      return `${index + 1}. ${badge ? `${badge} ` : ''}${label} — ${item.messageCount} сообщений`;
    });
    const trophyEmoji = premiumEmojis.getCustomEmojiFallback('trophy_premium');
    const topText = `${trophyEmoji} Топ по сообщениям в этой группе:\n${lines.join('\n')}`;
    const topEntities = [];

    // Добавляем кастомный трофей эмоджи в старт
    const trophyInfo = premiumEmojis.getCustomEmojiInfo('trophy_premium');
    if (trophyInfo && trophyInfo.id) {
      topEntities.push({
        type: 'custom_emoji',
        offset: 0,
        length: trophyInfo.fallback.length,
        custom_emoji_id: trophyInfo.id,
      });
    }

    if (streaksEnabled) {
      top.forEach((item, index) => {
        const badgeInfo = premiumEmojis.getStreakBadgeInfo(item.streak || 0);
        if (!badgeInfo) {
          return;
        }
        const badgeText = premiumEmojis.getStreakBadge(item.streak || 0);
        const line = lines[index];
        const lineStart = topText.indexOf(line);
        const fallbackText = String(badgeInfo.fallback);
        const badgeStart = topText.indexOf(fallbackText, lineStart >= 0 ? lineStart : 0);
        if (badgeStart >= 0) {
          topEntities.push({
            type: 'custom_emoji',
            offset: badgeStart,
            length: fallbackText.length,
            custom_emoji_id: badgeInfo.id,
          });
        }
      });
    }

    ctx.reply(topText, {
      entities: topEntities.length ? topEntities : undefined,
    });
  }

  function listPunishmentsCommand(ctx, kind, args = '') {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const page = parsePageNumber(args);
    const punishments = kind === 'mute'
      ? database.getActivePunishments(ctx.chat.id).filter((item) => item.action === 'mute')
      : database.getActivePunishments(ctx.chat.id).filter((item) => item.action === 'ban');

    ctx.reply(buildPunishmentListMessage(kind, punishments, page, 10));
  }

  function listBotAdminsCommand(ctx) {
    ensureGroup(ctx);
    const allAdminIds = database.getBotAdmins(ctx.chat.id);

    // group by level
    const grouped = { '1': [], '2': [], '3': [], '4': [], '5': [] };

    allAdminIds.forEach((userId) => {
      const level = database.getBotAdminLevel(ctx.chat.id, userId) || 5;
      const profile = database.getUserProfile(ctx.chat.id, userId);
      let label = profile?.username || profile?.displayName || `User ${userId}`;
      // Normalize label to single @ if it's a username
      if (String(label).startsWith('@')) {
        label = `@${String(label).replace(/^@+/, '')}`;
      }
      grouped[String(level)].push(label);
    });

    ctx.reply(buildBotAdminListMessage(grouped));
  }

  function getBotAdminActionPermissionLevel(actionName) {
    const normalizedAction = String(actionName || '').toLowerCase();
    if (['warn', 'unwarn', 'delwarn', 'mute', 'unmute', 'delmute'].includes(normalizedAction)) {
      return 5;
    }
    if (['ban', 'unban', 'delban'].includes(normalizedAction)) {
      return 4;
    }
    if (['clear_history', 'clearpunishmenthistory'].includes(normalizedAction)) {
      return 2;
    }
    if (['manage_admins'].includes(normalizedAction)) {
      return 2;
    }
    return null;
  }

  function canUseBotAdminAction(ctx, actionName) {
    const actorLevel = database.isPrimaryBotAdmin(ctx.chat.id, ctx.from.id)
      ? 1
      : database.getBotAdminLevel(ctx.chat.id, ctx.from.id);
    const maxAllowedLevel = getBotAdminActionPermissionLevel(actionName);

    if (!maxAllowedLevel || !Number.isFinite(Number(actorLevel))) {
      return false;
    }

    return Number(actorLevel) <= Number(maxAllowedLevel);
  }

  function ensureBotAdminCanPunishTarget(ctx, targetUserId, actionName) {
    if (canSelfClearPunishmentHistory(ctx, targetUserId, actionName)) {
      return true;
    }

    if (!database.isBotAdmin(ctx.chat.id, targetUserId)) {
      return true;
    }

    if (!database.canPunishBotAdmin(ctx.chat.id, ctx.from.id, targetUserId)) {
      ctx.reply('Ты не можешь наказывать админов выше себя.');
      return false;
    }

    if (!canUseBotAdminAction(ctx, actionName)) {
      ctx.reply('У тебя нет прав на это действие.');
      return false;
    }

    return true;
  }

  function rulesCommand(ctx) {
    if (isGroupChat(ctx) && !moderationService.isRulesEnabled(ctx.chat.id)) {
      ctx.reply('⚠️ Функция правил отключена в этом чате. Включите её через /menu.');
      return;
    }
    ctx.reply(moderationService.getRules(ctx.chat.id));
  }

  function setRulesCommand(ctx, args) {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    const text = args.trim();
    if (!text) {
      ctx.reply('Использование: /setrules текст правил или !установить_правила текст правил');
      return;
    }
    moderationService.setRules(ctx.chat.id, text);
    ctx.reply('Правила чата обновлены.');
  }

  async function clearUserPunishmentHistoryCommand(ctx, args) {
    ensureGroup(ctx);
    scheduleDeleteForContext(ctx, ctx.message?.message_id);
    if (!isBotAdmin(ctx)) {
      await replyWithAutoDelete(ctx, 'Эта команда доступна только администраторам.');
      return;
    }

    if (!canUseBotAdminAction(ctx, 'clear_history')) {
      await replyWithAutoDelete(ctx, 'Эта команда доступна только админам уровня «Ведущий» и выше.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, '/clearhistory @юз');
    if (!targetData) {
      return;
    }

    if (!ensureBotAdminCanPunishTarget(ctx, targetData.target.id, 'clear_history')) {
      return;
    }

    database.clearUserPunishmentHistory(ctx.chat.id, targetData.target.id);
    moderationService.resetWarnings(ctx.chat.id, targetData.target.id);
    await replyWithAutoDelete(ctx, `История наказаний пользователя ${targetData.target.first_name || targetData.target.username || targetData.target.id} сброшена.`);
  }

  async function warnCommand(ctx, args, deleteTargetMessage = false) {
    ensureGroup(ctx);
    scheduleDeleteForContext(ctx, ctx.message?.message_id);
    if (!isBotAdmin(ctx)) {
      await replyWithAutoDelete(ctx, 'Эта команда доступна только администраторам.');
      return;
    }

    if (deleteTargetMessage && !ctx.message?.reply_to_message) {
      await replyWithAutoDelete(ctx, 'Ответьте этой командой на сообщение пользователя, которому нужно выдать предупреждение и удалить сообщение.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, '/warn @юз причина');
    if (!targetData) {
      return;
    }

    if (!ensureBotAdminCanPunishTarget(ctx, targetData.target.id, 'warn')) {
      return;
    }

    const details = parsePunishmentDetails(targetData.remainingArgs, !!ctx.message.reply_to_message);
    moderationService.addWarning(ctx.chat.id, targetData.target.id);
    database.addPunishment(ctx.chat.id, targetData.target.id, 'warn', details.reason, null);
    const warningCount = moderationService.getWarnings(ctx.chat.id, targetData.target.id);
    const warnLimit = moderationService.getWarnLimit(ctx.chat.id);
    
    // Никнейм и причина без экранирования (репливитьКастомЭмоджи использует entities, а не parse_mode)
    const userName = targetData.target.first_name || targetData.target.username || String(targetData.target.id);
    const reasonEscaped = details.reason;
    
    if (warningCount >= warnLimit) {
      // Auto-ban after reaching limit
      const blockDuration = moderationService.getWarnBlockDuration(ctx.chat.id);
      const untilDate = Math.floor(Date.now() / 1000) + Math.round(blockDuration * 3600);
      try {
        await ctx.telegram.banChatMember(ctx.chat.id, targetData.target.id, untilDate);
      } catch (error) {
        const sentMsg3 = await premiumEmojis.replyWithCustomEmoji(ctx, `{alert} Не удалось выполнить автобан для ${userName} после ${warnLimit} предупреждений.`, { '{alert}': 'warning_alert' }, { parse_mode: 'HTML' });
        scheduleDeleteForContext(ctx, sentMsg3?.message_id, 5000);
        return;
      }
      database.addPunishment(ctx.chat.id, targetData.target.id, 'ban', `Автобан после ${warnLimit} предупреждений. Последнее: ${details.reason}`, untilDate);
      database.addActivePunishment(ctx.chat.id, targetData.target.id, 'ban', `Автобан после ${warnLimit} предупреждений. Последнее: ${details.reason}`, untilDate);
      schedulePunishmentExpiry({
        chatId: ctx.chat.id,
        userId: targetData.target.id,
        action: 'ban',
        untilAt: untilDate,
      });
      const sentMsg4 = await premiumEmojis.replyWithCustomEmoji(ctx, `{alert} ${userName}: Получил ${warnLimit}-е предупреждение и забанен на ${blockDuration}ч. Причина: ${reasonEscaped}`, { '{alert}': 'warning_alert' }, { parse_mode: 'HTML' });
      scheduleDeleteForContext(ctx, sentMsg4?.message_id, 5000);
    } else {
      const sentMsg5 = await premiumEmojis.replyWithCustomEmoji(ctx, `{alert} Предупреждение для ${userName}: ${warningCount}/${warnLimit}. Причина: ${reasonEscaped}`, { '{alert}': 'warning_alert' }, { parse_mode: 'HTML' });
      scheduleDeleteForContext(ctx, sentMsg5?.message_id, 5000);
    }

    if (deleteTargetMessage) {
      await deleteMessageSafely(ctx, ctx.message.reply_to_message.message_id);
    }
  }

  async function warningsCommand(ctx, args = '') {
    ensureGroup(ctx);
    scheduleDeleteForContext(ctx, ctx.message?.message_id);
    let target = ctx.message.reply_to_message?.from || ctx.from;
    if (args && args.trim()) {
      const targetData = await resolveCommandTarget(ctx, args, '/warnings @юз');
      if (!targetData) {
        return;
      }
      target = targetData.target;
    }
    const warnLimit = moderationService.getWarnLimit(ctx.chat.id);
    await replyWithAutoDelete(ctx, `Предупреждений: ${moderationService.getWarnings(ctx.chat.id, target.id)}/${warnLimit}`);
  }

  async function unwarnCommand(ctx, args) {
    ensureGroup(ctx);
    scheduleDeleteForContext(ctx, ctx.message?.message_id);
    if (!isBotAdmin(ctx)) {
      await replyWithAutoDelete(ctx, 'Эта команда доступна только администраторам.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, '/unwarn @юз');
    if (!targetData) {
      return;
    }

    if (!ensureBotAdminCanPunishTarget(ctx, targetData.target.id, 'unwarn')) {
      return;
    }

    moderationService.resetWarnings(ctx.chat.id, targetData.target.id);
    await replyWithAutoDelete(ctx, `Предупреждения пользователя ${targetData.target.first_name || targetData.target.username || targetData.target.id} сброшены.`);
  }

  async function muteCommand(ctx, args, deleteTargetMessage = false) {
    ensureGroup(ctx);
    scheduleDeleteForContext(ctx, ctx.message?.message_id);
    if (!isBotAdmin(ctx)) {
      await replyWithAutoDelete(ctx, 'Эта команда доступна только администраторам.');
      return;
    }

    if (deleteTargetMessage && !ctx.message?.reply_to_message) {
      await replyWithAutoDelete(ctx, 'Ответьте этой командой на сообщение пользователя, которому нужно выдать mute и удалить сообщение.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, '/mute @юз <время> <причина>');
    if (!targetData) {
      return;
    }

    if (!ensureBotAdminCanPunishTarget(ctx, targetData.target.id, 'mute')) {
      return;
    }

    const details = parsePunishmentDetails(targetData.remainingArgs, !!ctx.message.reply_to_message);
    const untilDate = details.durationHours ? Math.floor(Date.now() / 1000) + Math.round(details.durationHours * 3600) : undefined;

    try {
      await ctx.telegram.restrictChatMember(ctx.chat.id, targetData.target.id, buildMutePermissions(false), untilDate);
    } catch (error) {
      await replyWithAutoDelete(ctx, 'Не удалось применить mute: у бота нет прав администратора или запрет не поддерживается в этом чате.');
      return;
    }

    database.addPunishment(ctx.chat.id, targetData.target.id, 'mute', details.reason, untilDate || null);
    database.addActivePunishment(ctx.chat.id, targetData.target.id, 'mute', details.reason, untilDate || null);
    if (untilDate) {
      schedulePunishmentExpiry({
        chatId: ctx.chat.id,
        userId: targetData.target.id,
        action: 'mute',
        untilAt: untilDate,
      });
    }

    const targetLabel = getMentionText(targetData.target);
    const durationLabel = formatDurationLabel(details.durationHours);
    const sentMsg = await premiumEmojis.replyWithCustomEmoji(ctx, `{lock} ${targetLabel} получил mute на ${durationLabel}. Причина: ${details.reason}`, { '{lock}': 'mute_lock' });
    scheduleDeleteForContext(ctx, sentMsg?.message_id, 5000);
    if (deleteTargetMessage) {
      await deleteMessageSafely(ctx, ctx.message.reply_to_message.message_id);
    }
  }

  async function unmuteCommand(ctx, args) {
    ensureGroup(ctx);
    scheduleDeleteForContext(ctx, ctx.message?.message_id);
    if (!isBotAdmin(ctx)) {
      await replyWithAutoDelete(ctx, 'Эта команда доступна только администраторам.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, '/unmute @юз');
    if (!targetData) {
      return;
    }

    if (!ensureBotAdminCanPunishTarget(ctx, targetData.target.id, 'unmute')) {
      return;
    }

    try {
      await ctx.telegram.restrictChatMember(ctx.chat.id, targetData.target.id, buildMutePermissions(true));
      database.removeActivePunishment(ctx.chat.id, targetData.target.id, 'mute');
      clearScheduledPunishment(ctx.chat.id, targetData.target.id, 'mute');
    } catch (error) {
      await replyWithAutoDelete(ctx, 'Не удалось снять mute: у бота нет прав администратора.');
      return;
    }

    await replyWithAutoDelete(ctx, `Ограничения с пользователя ${targetData.target.first_name || targetData.target.username || targetData.target.id} сняты.`);
  }

  async function banCommand(ctx, args) {
    ensureGroup(ctx);
    scheduleDeleteForContext(ctx, ctx.message?.message_id);
    if (!isBotAdmin(ctx)) {
      await replyWithAutoDelete(ctx, 'Эта команда доступна только администраторам.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, '/ban @юз <время> <причина>');
    if (!targetData) {
      return;
    }

    if (!ensureBotAdminCanPunishTarget(ctx, targetData.target.id, 'ban')) {
      return;
    }

    const details = parsePunishmentDetails(targetData.remainingArgs, !!ctx.message.reply_to_message);
    const untilDate = details.durationHours ? Math.floor(Date.now() / 1000) + Math.round(details.durationHours * 3600) : undefined;

    try {
      await ctx.telegram.banChatMember(ctx.chat.id, targetData.target.id, untilDate);
    } catch (error) {
      await replyWithAutoDelete(ctx, 'Не удалось выполнить ban: у бота нет прав администратора или пользователь не может быть заблокирован.');
      return;
    }

    database.addPunishment(ctx.chat.id, targetData.target.id, 'ban', details.reason, untilDate || null);
    database.addActivePunishment(ctx.chat.id, targetData.target.id, 'ban', details.reason, untilDate || null);
    if (untilDate) {
      schedulePunishmentExpiry({
        chatId: ctx.chat.id,
        userId: targetData.target.id,
        action: 'ban',
        untilAt: untilDate,
      });
    }

    const targetLabel = getMentionText(targetData.target);
    const durationLabel = formatDurationLabel(details.durationHours);
    await replyWithAutoDelete(ctx, `⛔ ${targetLabel} получил ban на ${durationLabel}. Причина: ${details.reason}`);
  }

  async function delBanCommand(ctx, args) {
    ensureGroup(ctx);
    scheduleDeleteForContext(ctx, ctx.message?.message_id);
    if (!isBotAdmin(ctx)) {
      await replyWithAutoDelete(ctx, 'Эта команда доступна только администраторам.');
      return;
    }

    if (!ctx.message?.reply_to_message) {
      await replyWithAutoDelete(ctx, 'Ответьте этой командой на сообщение пользователя, которого нужно заблокировать и удалить.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, '/delban <время> <причина>');
    if (!targetData) {
      return;
    }

    if (!ensureBotAdminCanPunishTarget(ctx, targetData.target.id, 'delban')) {
      return;
    }

    const details = parsePunishmentDetails(targetData.remainingArgs, true);
    const untilDate = details.durationHours ? Math.floor(Date.now() / 1000) + Math.round(details.durationHours * 3600) : undefined;

    try {
      await ctx.telegram.banChatMember(ctx.chat.id, targetData.target.id, untilDate);
    } catch (error) {
      await replyWithAutoDelete(ctx, 'Не удалось выполнить ban: у бота нет прав администратора или пользователь не может быть заблокирован.');
      return;
    }

    database.addPunishment(ctx.chat.id, targetData.target.id, 'ban', details.reason, untilDate || null);
    database.addActivePunishment(ctx.chat.id, targetData.target.id, 'ban', details.reason, untilDate || null);
    if (untilDate) {
      schedulePunishmentExpiry({
        chatId: ctx.chat.id,
        userId: targetData.target.id,
        action: 'ban',
        untilAt: untilDate,
      });
    }

    await deleteMessageSafely(ctx, ctx.message.reply_to_message.message_id);
    const targetLabel = getMentionText(targetData.target);
    const durationLabel = formatDurationLabel(details.durationHours);
    await replyWithAutoDelete(ctx, `⛔ ${targetLabel} получил ban на ${durationLabel}, сообщение удалено. Причина: ${details.reason}`);
  }

  async function unbanCommand(ctx, args) {
    ensureGroup(ctx);
    scheduleDeleteForContext(ctx, ctx.message?.message_id);
    if (!isBotAdmin(ctx)) {
      await replyWithAutoDelete(ctx, 'Эта команда доступна только администраторам.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, '/unban @юз');
    if (!targetData) {
      return;
    }

    if (!ensureBotAdminCanPunishTarget(ctx, targetData.target.id, 'unban')) {
      return;
    }

    try {
      await ctx.telegram.unbanChatMember(ctx.chat.id, targetData.target.id, true);
      database.removeActivePunishment(ctx.chat.id, targetData.target.id, 'ban');
      clearScheduledPunishment(ctx.chat.id, targetData.target.id, 'ban');
    } catch (error) {
      await replyWithAutoDelete(ctx, 'Не удалось снять ban: у бота нет прав администратора.');
      return;
    }

    await replyWithAutoDelete(ctx, `Пользователь ${targetData.target.first_name || targetData.target.username || targetData.target.id} разблокирован.`);
  }

  function setGreetingCommand(ctx, args) {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    const text = args.trim();
    if (!text) {
      ctx.reply('Использование: /setgreeting текст приветствия или !установить_приветствие текст приветствия');
      return;
    }
    moderationService.setGreeting(ctx.chat.id, text);
    ctx.reply('Приветствие чата обновлено.');
  }

  async function addBotAdminCommand(ctx, args = '') {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Только главный или вспомогательный администратор бота может добавлять новых админов.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, '/addadmin @юз [уровень]');
    if (!targetData) {
      return;
    }

    const target = targetData.target;
    const argRest = (targetData.remainingArgs || '').trim();
    const requestedLevel = argRest ? Number(argRest.split(/\s+/)[0]) : null;
    const isPrimary = database.isPrimaryBotAdmin(ctx.chat.id, ctx.from.id);
    const actorLevel = isPrimary ? 1 : database.getBotAdminLevel(ctx.chat.id, ctx.from.id);

    if (!isPrimary && target.id === ctx.from.id) {
      ctx.reply('Нельзя назначить себя дополнительным администратором.');
      return;
    }

    if (database.isPrimaryBotAdmin(ctx.chat.id, target.id)) {
      ctx.reply('Нельзя изменить уровень главного администратора.');
      return;
    }

    if (!isPrimary && (!actorLevel || actorLevel > 2)) {
      ctx.reply('Только главный админ или ведущий админ могут назначать новых админов.');
      return;
    }

    const targetAlreadyAdmin = database.isBotAdmin(ctx.chat.id, target.id);
    if (!isPrimary && targetAlreadyAdmin && !database.canManageBotAdmin(ctx.chat.id, ctx.from.id, target.id)) {
      ctx.reply('У вас нет прав управлять этим администратором.');
      return;
    }

    if (targetAlreadyAdmin && !Number.isFinite(requestedLevel)) {
      const existingLevel = database.getBotAdminLevel(ctx.chat.id, target.id);
      ctx.reply(`Пользователь ${getMentionText(target)} уже является админом уровня ${existingLevel}.`);
      return;
    }

    let assignedLevel = 5;
    if (Number.isFinite(requestedLevel)) {
      assignedLevel = Number(requestedLevel);
    }

    if (assignedLevel < 2 || assignedLevel > 5) {
      ctx.reply('Уровень должен быть от 2 до 5.');
      return;
    }

    if (!isPrimary && assignedLevel <= actorLevel) {
      ctx.reply('Вы не можете назначить администратора уровня не выше своего.');
      return;
    }

    database.addBotAdmin(ctx.chat.id, target.id, assignedLevel);

    if (targetAlreadyAdmin) {
      ctx.reply(`Пользователь ${getMentionText(target)} теперь админ уровня ${assignedLevel}.`);
    } else {
      ctx.reply(`Пользователь ${getMentionText(target)} назначен админом уровня ${assignedLevel}.`);
    }
  }

  async function removeBotAdminCommand(ctx, args = '') {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Только главный или вспомогательный администратор бота может снимать админов.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, '/removeadmin @юз');
    if (!targetData) {
      return;
    }

    const target = targetData.target;
    const isPrimary = database.isPrimaryBotAdmin(ctx.chat.id, ctx.from.id);
    const actorLevel = isPrimary ? 1 : database.getBotAdminLevel(ctx.chat.id, ctx.from.id);

    if (database.isPrimaryBotAdmin(ctx.chat.id, target.id)) {
      ctx.reply('Нельзя снять главного администратора бота.');
      return;
    }

    if (target.id === ctx.from.id) {
      ctx.reply('Нельзя снять себя с роли администратора бота.');
      return;
    }

    if (!database.isBotAdmin(ctx.chat.id, target.id)) {
      ctx.reply('Этот пользователь не является вспомогательным администратором бота.');
      return;
    }

    if (!isPrimary && (!actorLevel || actorLevel > 2)) {
      ctx.reply('Только главный админ или ведущий админ могут снимать админов.');
      return;
    }

    if (!isPrimary && !database.canManageBotAdmin(ctx.chat.id, ctx.from.id, target.id)) {
      ctx.reply('У вас нет прав управлять этим администратором.');
      return;
    }

    if (!database.removeBotAdmin(ctx.chat.id, target.id)) {
      ctx.reply('Не удалось снять этого администратора.');
      return;
    }

    ctx.reply(`Пользователь ${target.first_name || target.username || target.id} больше не является вспомогательным администратором бота.`);
  }

  async function adjustBotAdminLevelCommand(ctx, args = '', action = 'promote') {
    // action: 'promote' (уменьшить numeric level) or 'demote' (увеличить numeric level)
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, `/${action} @юз [уровень]`);
    if (!targetData) return;
    const target = targetData.target;
    const argRest = (targetData.remainingArgs || '').trim();
    const requestedLevel = argRest ? Number(argRest.split(/\s+/)[0]) : null;

    const isPrimary = database.isPrimaryBotAdmin(ctx.chat.id, ctx.from.id);
    const actorLevel = isPrimary ? 1 : database.getBotAdminLevel(ctx.chat.id, ctx.from.id);

    if (!isPrimary && (!actorLevel || actorLevel > 2)) {
      ctx.reply('Только главный админ или ведущий админ могут управлять уровнями администраторов.');
      return;
    }

    if (database.isPrimaryBotAdmin(ctx.chat.id, target.id)) {
      ctx.reply('Нельзя изменять уровень главному администратору.');
      return;
    }

    const currentLevel = database.getBotAdminLevel(ctx.chat.id, target.id);
    const baseline = currentLevel === null ? 6 : Number(currentLevel);
    let newLevel = baseline;

    if (Number.isFinite(requestedLevel)) {
      newLevel = Number(requestedLevel);
    } else {
      if (action === 'promote') {
        newLevel = Math.max(1, baseline - 1);
      } else {
        newLevel = Math.min(5, baseline + 1);
      }
    }

    if (newLevel < 1 || newLevel > 5) {
      ctx.reply('Уровень должен быть в диапазоне 1-5.');
      return;
    }

    if (newLevel === baseline) {
      ctx.reply(`У пользователя ${getMentionText(target)} уже уровень ${newLevel}.`);
      return;
    }

    if (newLevel <= actorLevel) {
      ctx.reply('Нельзя повысить или понизить администратора до уровня, равного или выше вашего.');
      return;
    }

    if (currentLevel === null) {
      if (!isPrimary && actorLevel > 2) {
        ctx.reply('У вас нет прав назначать новых админов.');
        return;
      }

      if (action === 'demote') {
        ctx.reply('Нельзя понижать пользователя, который ещё не является администратором.');
        return;
      }

      database.addBotAdmin(ctx.chat.id, target.id, newLevel);
      ctx.reply(`Пользователь ${getMentionText(target)} назначен админом уровня ${newLevel}.`);
      return;
    }

    if (!isPrimary && !database.canManageBotAdmin(ctx.chat.id, ctx.from.id, target.id)) {
      ctx.reply('У вас нет прав управлять этим администратором.');
      return;
    }

    database.addBotAdmin(ctx.chat.id, target.id, newLevel);

    const actionLabel = action === 'promote' ? 'повышен' : 'понижен';
    ctx.reply(`Пользователь ${getMentionText(target)} ${actionLabel} с уровня ${currentLevel} до уровня ${newLevel}.`);
  }

  async function handleRussianCommand(ctx, text) {
    const [commandWithBot, ...parts] = text.slice(1).split(/\s+/);
    const command = commandWithBot.split('@')[0].toLowerCase();
    const args = parts.join(' ');
    const normalizedCommand = command.replace(/_/g, ' ');
    const secondWord = parts[0]?.toLowerCase() || '';

    switch (normalizedCommand) {
      case 'начало':
        startCommand(ctx);
        return true;
      case 'помощь':
        helpCommand(ctx);
        return true;
      case 'айди':
        idCommand(ctx);
        return true;
      case 'информация':
        aboutCommand(ctx);
        return true;
      case 'кто':
        if (secondWord === 'я') {
          whoamiCommand(ctx);
          return true;
        }
        return false;
      case 'статистика':
        statsCommand(ctx);
        return true;
      case 'правила':
        rulesCommand(ctx);
        return true;
      case 'установить':
        if (secondWord === 'правила') {
          setRulesCommand(ctx, args.replace(/^правила\s*/i, ''));
          return true;
        }
        if (secondWord === 'приветствие') {
          setGreetingCommand(ctx, args.replace(/^приветствие\s*/i, ''));
          return true;
        }
        return false;
      case 'предупреждение':
        await warnCommand(ctx, args);
        return true;
      case 'delwarn':
        await warnCommand(ctx, args, true);
        return true;
      case 'варны':
        await warningsCommand(ctx, args);
        return true;
      case 'снять':
        if (secondWord === 'предупреждение') {
          await unwarnCommand(ctx, args.replace(/^предупреждение\s*/i, ''));
          return true;
        }
        return false;
      case 'мут':
        await muteCommand(ctx, args);
        return true;
      case 'delmute':
        await muteCommand(ctx, args, true);
        return true;
      case 'размут':
        await unmuteCommand(ctx, args);
        return true;
      case 'бан':
        await banCommand(ctx, args);
        return true;
      case 'delban':
        await delBanCommand(ctx, args);
        return true;
      case 'разбан':
        await unbanCommand(ctx, args);
        return true;
      case 'установить приветствие':
        setGreetingCommand(ctx, args);
        return true;
      case 'добавить':
        if (secondWord === 'админа') {
          await addBotAdminCommand(ctx, args.replace(/^админа\s*/i, ''));
          return true;
        }
        return false;
      case 'снять':
        if (secondWord === 'админа') {
          await removeBotAdminCommand(ctx, args.replace(/^админа\s*/i, ''));
          return true;
        }
        return false;
      case 'топ':
        topCommand(ctx);
        return true;
      case 'баны':
        listPunishmentsCommand(ctx, 'ban', args);
        return true;
      case 'муты':
        listPunishmentsCommand(ctx, 'mute', args);
        return true;
      case 'админы':
        listBotAdminsCommand(ctx);
        return true;
      case 'обнять':
        await roleplayCommand(ctx, args, 'hug');
        return true;
      case 'поцеловать':
        await roleplayCommand(ctx, args, 'kiss');
        return true;
      case 'шлепнуть':
        await roleplayCommand(ctx, args, 'slap');
        return true;
      case 'тыкнуть':
        await roleplayCommand(ctx, args, 'poke');
        return true;
      case 'вьебать':
        await roleplayCommand(ctx, args, 'fuck');
        return true;
      case 'выебать':
        await roleplayCommand(ctx, args, 'fuck');
        return true;
      case 'трахнуть':
        await roleplayCommand(ctx, args, 'rape');
        return true;
      case 'уебать':
        await roleplayCommand(ctx, args, 'beat');
        return true;
      case 'убить':
        await roleplayCommand(ctx, args, 'kill');
        return true;
      case 'укусить':
        await roleplayCommand(ctx, args, 'bite');
        return true;
      case 'лизнуть':
        await roleplayCommand(ctx, args, 'lick');
        return true;
      case 'отлизать':
        await roleplayCommand(ctx, args, 'lickup');
        return true;
      case 'монетка':
        funCommand(ctx, 'coin');
        return true;
      case 'кубик':
        funCommand(ctx, 'dice');
        return true;
      case 'вопрос':
        funCommand(ctx, 'fate');
        return true;
      case 'комплимент':
        funCommand(ctx, 'compliment');
        return true;
      case 'похвала':
        funCommand(ctx, 'insult');
        return true;
      default:
        return false;
    }
  }

  bot.command(['start', 'начало'], startCommand);
  bot.command(['help', 'помощь'], helpCommand);
  bot.command(['bot', 'бот'], botCommand);

  bot.action(/^help:(\d+)$/, async (ctx) => {
    const pageIndex = Number(ctx.match[1]);
    const helpPage = buildHelpPage(pageIndex);
    await safeAnswerCbQuery(ctx);
    await ctx.editMessageText(helpPage.text, { reply_markup: helpPage.reply_markup });
  });

  bot.action('admincom:close', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    if (!await canUseAdminPunishmentCommands(ctx)) {
      await ctx.reply('Закрыть памятку может только администратор.');
      return;
    }
    try {
      await ctx.deleteMessage();
    } catch (error) {
      // Ignore stale or already deleted messages.
    }
  });

  bot.action(/^settings:(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const callbackData = ctx.callbackQuery?.data || `settings:${action}`;
    const directTimeoutOpen = callbackData.match(/^settings:captcha_timeout:(-?\d+)$/);
    const directTimeoutSet = callbackData.match(/^settings:captcha_timeout_set:(-?\d+):(-?\d+)$/);

    let parsed = parseSettingsAction(action);
    if (directTimeoutOpen) {
      parsed = { ...parsed, target: 'captcha_timeout', chatId: Number(directTimeoutOpen[1]) || 0 };
    } else if (directTimeoutSet) {
      parsed = { ...parsed, target: 'captcha_timeout_set', chatId: Number(directTimeoutSet[1]) || 0, value: directTimeoutSet[2] };
    }

    const chatId = Number(parsed.chatId || ctx.chat?.id || 0);
    if (!chatId) {
      try {
        await ctx.answerCbQuery();
      } catch (error) {
        // ignore stale callback_query errors
      }
      return;
    }
    try {
      await ctx.answerCbQuery();
    } catch (error) {
      // ignore stale callback_query errors
    }

    if (!await canManageGroupSettings(ctx, chatId)) {
      await ctx.reply('У вас нет прав менять настройки этой группы.');
      return;
    }

    if (parsed.target === 'select_group') {
      await showSettingsGroupSelector(ctx);
      return;
    }

    if (parsed.target === 'select') {
      await openSettingsForCurrentContext(ctx, chatId);
      return;
    }

    if (parsed.target === 'main') {
      await showSettingsMainMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'section') {
      if (parsed.section === 'captcha') {
        await showSettingsCaptchaMenu(ctx, chatId);
      } else if (parsed.section === 'links') {
        await showSettingsLinksMenu(ctx, chatId);
      } else if (parsed.section === 'anti') {
        await showSettingsAntiMenu(ctx, chatId);
      } else if (parsed.section === 'first') {
        await showSettingsFirstMessageMenu(ctx, chatId);
      } else if (parsed.section === 'rules') {
        await showSettingsRulesMenu(ctx, chatId);
      } else if (parsed.section === 'admin') {
        await showSettingsAdminMenu(ctx, chatId);
      } else if (parsed.section === 'media_ai') {
        await showSettingsMediaAiMenu(ctx, chatId);
      } else if (parsed.section === 'banwords') {
        await showSettingsBanwordsMenu(ctx, chatId);
      } else if (parsed.section === 'warns') {
        await showSettingsWarnsMenu(ctx, chatId);
      } else if (parsed.section === 'streaks') {
        await showSettingsStreaksMenu(ctx, chatId);
      } else if (parsed.section === 'anonymous') {
        await showSettingsAnonymousMenu(ctx, chatId);
      } else if (parsed.section === 'chat') {
        await showSettingsChatMenu(ctx, chatId);
      } else if (parsed.section === 'mention') {
        await showMentionNotificationMenu(ctx, chatId, 'settings');
      } else if (parsed.section === 'members') {
        await showMembersManagementMenu(ctx, chatId);
      } else if (parsed.section === 'commands') {
        // Open interactive command rights UI from settings menu
        await showMenuCommandRightsMenu(ctx, chatId, 0, `settings:main:${chatId}`, 'settings');
      }
      return;
    }

    if (parsed.target === 'chat_access') {
      const service = activeModerationService || defaultModerationService;
      const mode = String(parsed.value || '').trim().toLowerCase();
      const labels = {
        open: '✅ Открыт',
        closed: '✅ Закрыт',
        admins: '✅ Только администраторы',
        owner: '✅ Только владелец',
      };

      if (service.setChatAccessMode(chatId, mode)) {
        await safeAnswerCbQuery(ctx, labels[mode] || '✅ Режим изменён');
      } else {
        await safeAnswerCbQuery(ctx, '⚠️ Неверный режим');
      }

      await showSettingsChatMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'toggle_links') {
      if (parsed.value === 'on') {
        moderationService.enableLinkProtection(chatId);
      } else {
        moderationService.disableLinkProtection(chatId);
      }
      await showSettingsLinksMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'rules_toggle') {
      const service = activeModerationService || defaultModerationService;
      if (service.isRulesEnabled(chatId)) {
        service.disableRules(chatId);
      } else {
        service.enableRules(chatId);
      }
      await showSettingsRulesMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'toggle_streaks') {
      const service = activeModerationService || defaultModerationService;
      if (parsed.value === 'on') {
        service.enableStreaks(chatId);
      } else {
        service.disableStreaks(chatId);
      }
      await showSettingsStreaksMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'streaks_label') {
      setPendingSettingsAction(ctx, { action: 'settings_streaks_label', groupId: chatId });
      await ctx.reply('Введите название системы серий. Например: Серия, Стрик, Рейтинг, Стаж или Прогресс.');
      return;
    }

    if (parsed.target === 'toggle_captcha') {
      if (parsed.value === 'on') {
        moderationService.enableCaptcha(chatId);
      } else {
        moderationService.disableCaptcha(chatId);
      }
      await showSettingsCaptchaMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'agreement') {
      await showSettingsAgreementMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'toggle_agreement') {
      if (parsed.value === 'on') {
        moderationService.enableAgreement(chatId);
      } else {
        moderationService.disableAgreement(chatId);
      }
      await showSettingsAgreementMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'agreement_edit') {
      setPendingSettingsAction(ctx, { action: 'settings_agreement_text', groupId: chatId });
      await ctx.reply('Отправьте новый текст пользовательского соглашения. Можно вставить ссылку или описание правил.');
      return;
    }

    if (parsed.target === 'agreement_media') {
      setPendingSettingsAction(ctx, { action: 'settings_agreement_media', groupId: chatId });
      await ctx.reply('Отправьте медиа для пользовательского соглашения.');
      return;
    }

    if (parsed.target === 'agreement_remove_media') {
      moderationService.clearAgreementMedia(chatId);
      await ctx.reply('✅ Медиа для соглашения удалено.');
      await showSettingsAgreementMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'captcha_modes') {
      await ctx.editMessageText('Выберите режим капчи:', { reply_markup: buildCaptchaModesKeyboard(chatId) });
      return;
    }

    if (parsed.target === 'captcha_mode') {
      const selectedMode = parsed.value || '';
      moderationService.setCaptchaMode(chatId, selectedMode);
      await showSettingsCaptchaMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'captcha_timeout') {
      await ctx.editMessageText('Выберите время на прохождение капчи:', { reply_markup: buildCaptchaTimeoutKeyboard(chatId) });
      return;
    }

    if (parsed.target === 'captcha_timeout_set') {
      const minutes = Number(parsed.value || 0);
      moderationService.setCaptchaTimeoutMinutes(chatId, minutes);
      await showSettingsCaptchaMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'toggle_spam') {
      if (parsed.value === 'on') {
        moderationService.enableSpamProtection(chatId);
      } else {
        moderationService.disableSpamProtection(chatId);
      }
      await showSettingsAntiMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'toggle_media_ai') {
      if (parsed.value === 'on') {
        moderationService.enableMediaAi(chatId);
      } else {
        moderationService.disableMediaAi(chatId);
      }
      await showSettingsMediaAiMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'toggle_flood') {
      if (parsed.value === 'on') {
        moderationService.enableFloodProtection(chatId);
      } else {
        moderationService.disableFloodProtection(chatId);
      }
      await showSettingsAntiMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'add_link') {
      setPendingSettingsAction(ctx, { action: 'settings_link_add', groupId: chatId });
      await ctx.reply(parseSettingsPrompt('settings_link_add'));
      return;
    }

    if (parsed.target === 'remove_link') {
      setPendingSettingsAction(ctx, { action: 'settings_link_remove', groupId: chatId });
      await ctx.reply(parseSettingsPrompt('settings_link_remove'));
      return;
    }

    if (parsed.target === 'forwards_menu') {
      await showSettingsForwardsMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'forwards_category') {
      const category = parsed.value || 'channels';
      await showSettingsForwardsCategoryMenu(ctx, chatId, category);
      return;
    }

    if (parsed.target === 'add_forward') {
      setPendingSettingsAction(ctx, { action: 'settings_forward_add', groupId: chatId });
      await ctx.reply(parseSettingsPrompt('settings_forward_add'));
      return;
    }

    if (parsed.target === 'add_forward_category') {
      const category = parsed.value || 'channels';
      const categoryNames = { channels: 'канал', groups: 'группу', users: 'пользователя', bots: 'бота' };
      setPendingSettingsAction(ctx, { action: 'settings_forward_add', groupId: chatId, category });
      await ctx.reply(`Отправьте @username, t.me/username или ID ${categoryNames[category]} для добавления в исключения.`);
      return;
    }

    if (parsed.target === 'remove_forward') {
      setPendingSettingsAction(ctx, { action: 'settings_forward_remove', groupId: chatId });
      await ctx.reply(parseSettingsPrompt('settings_forward_remove'));
      return;
    }

    if (parsed.target === 'remove_forward_category') {
      const category = parsed.value || 'channels';
      const categoryNames = { channels: 'канала', groups: 'группы', users: 'пользователя', bots: 'бота' };
      setPendingSettingsAction(ctx, { action: 'settings_forward_remove', groupId: chatId, category });
      await ctx.reply(`Отправьте @username, t.me/username или ID ${categoryNames[category]} для удаления из исключений.`);
      return;
    }

    if (parsed.target === 'forwards_settings') {
      const category = parsed.value || 'channels';
      await showSettingsForwardsSettingsMenu(ctx, chatId, category);
      return;
    }

    if (parsed.target === 'forwards_punishment') {
      const category = parsed.value || 'channels';
      await showSettingsForwardsPunishmentMenu(ctx, chatId, category);
      return;
    }

    if (parsed.target === 'set_forward_punishment') {
      const category = parsed.value || 'channels';
      const punishment = parsed.extra || 'warn';
      const service = activeModerationService || defaultModerationService;
      service.setForwardsPunishment(chatId, category, punishment);
      await showSettingsForwardsSettingsMenu(ctx, chatId, category);
      return;
    }

    if (parsed.target === 'forwards_delete') {
      const category = parsed.value || 'channels';
      await showSettingsForwardsDeleteMessageMenu(ctx, chatId, category);
      return;
    }

    if (parsed.target === 'set_forward_delete') {
      const category = parsed.value || 'channels';
      const deleteMessage = parsed.extra === 'true';
      const service = activeModerationService || defaultModerationService;
      service.setForwardsDeleteMessage(chatId, category, deleteMessage);
      await showSettingsForwardsSettingsMenu(ctx, chatId, category);
      return;
    }

    if (parsed.target === 'list_links') {
      await showSettingsLinksMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'open_menu') {
      await showSettingsFirstMessageMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'first_toggle') {
      const service = activeModerationService || defaultModerationService;
      if (service.getMenuEnabled(chatId)) {
        service.disableMenu(chatId);
      } else {
        service.enableMenu(chatId);
      }
      await showSettingsFirstMessageMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'first_text') {
      setPendingSettingsAction(ctx, { action: 'settings_message_text', groupId: chatId });
      await ctx.reply(parseSettingsPrompt('settings_message_text'));
      return;
    }

    if (parsed.target === 'first_buttons') {
      await showSettingsFirstMessageButtonsMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'admin_notify') {
      const action = String(parsed.value || '').toLowerCase();
      const service = activeModerationService || defaultModerationService;
      if (['none', 'owner', 'staff'].includes(action)) {
        service.setAdminNotifyMode(chatId, action);
      } else if (action === 'notify_owner') {
        service.setAdminNotifyOwner(chatId, !service.getAdminNotifyOwner(chatId));
      } else if (action === 'notify_admins') {
        service.setAdminNotifyAdmins(chatId, !service.getAdminNotifyAdmins(chatId));
      } else if (action === 'advanced') {
        service.setAdminNotifyAdvanced(chatId, !service.getAdminNotifyAdvanced(chatId));
      } else if (action === 'toggle_only_in_reply') {
        service.setAdminNotifyOnlyInReply(chatId, !service.getAdminNotifyOnlyInReply(chatId));
        await showSettingsAdminAdvancedMenu(ctx, chatId);
        return;
      } else if (action === 'toggle_reason_required') {
        service.setAdminNotifyReasonRequired(chatId, !service.getAdminNotifyReasonRequired(chatId));
        await showSettingsAdminAdvancedMenu(ctx, chatId);
        return;
      } else if (action === 'toggle_delete_on_process') {
        service.setAdminNotifyDeleteOnProcess(chatId, !service.getAdminNotifyDeleteOnProcess(chatId));
        await showSettingsAdminAdvancedMenu(ctx, chatId);
        return;
      } else if (action === 'toggle_delete_in_staff') {
        service.setAdminNotifyDeleteInStaffGroup(chatId, !service.getAdminNotifyDeleteInStaffGroup(chatId));
        await showSettingsAdminAdvancedMenu(ctx, chatId);
        return;
      }
      await showSettingsAdminMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'admin_notify_advanced') {
      await showSettingsAdminAdvancedMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'toggle_anonymous') {
      const service = activeModerationService || defaultModerationService;
      if (service.isHideAnonymousEnabled(chatId)) {
        service.disableHideAnonymous(chatId);
      } else {
        service.enableHideAnonymous(chatId);
      }
      await showSettingsAnonymousMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'toggle_delete_anonymous') {
      const service = activeModerationService || defaultModerationService;
      if (service.shouldDeleteAnonymousMessages(chatId)) {
        service.disableDeleteAnonymousMessages(chatId);
      } else {
        service.enableDeleteAnonymousMessages(chatId);
      }
      await showSettingsAnonymousMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'anonymous_exceptions') {
      await showSettingsAnonymousExceptionsMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'command_rights') {
      const pageIndex = Number(parsed.value || 0);
      await showSettingsCommandRightsMenu(ctx, chatId, Number.isFinite(pageIndex) ? pageIndex : 0);
      return;
    }

    if (parsed.target === 'anonymous_add_channel') {
      setPendingSettingsAction(ctx, { action: 'settings_anonymous_channel_add', groupId: chatId });
      await ctx.reply(parseSettingsPrompt('settings_anonymous_channel_add'));
      return;
    }

    if (parsed.target === 'anonymous_remove_channel') {
      setPendingSettingsAction(ctx, { action: 'settings_anonymous_channel_remove', groupId: chatId });
      await ctx.reply(parseSettingsPrompt('settings_anonymous_channel_remove'));
      return;
    }

    if (parsed.target === 'first_button_add_row') {
      const service = activeModerationService || defaultModerationService;
      service.addMenuRow(chatId);
      await showSettingsFirstMessageButtonsMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'first_button_remove_row') {
      const service = activeModerationService || defaultModerationService;
      const rowIndex = Number(parsed.value || 0);
      if (Number.isFinite(rowIndex) && service.removeMenuRow(chatId, rowIndex)) {
        await ctx.reply('✅ Ряд удалён.');
      } else {
        await ctx.reply('⚠️ Не удалось удалить ряд.');
      }
      await showSettingsFirstMessageButtonsMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'first_button_add') {
      const rowIndex = Number(parsed.value || 0);
      setPendingSettingsAction(ctx, { action: 'settings_message_button_add', groupId: chatId, rowIndex });
      await ctx.reply('Отправьте новую кнопку в формате: Название | URL');
      return;
    }

    if (parsed.target === 'first_button_remove_last') {
      const service = activeModerationService || defaultModerationService;
      const rows = service.getMenuButtons(chatId);
      let removed = false;
      for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
        const row = rows[rowIndex] || [];
        if (!row.length) {
          continue;
        }
        removed = service.removeMenuButton(chatId, rowIndex, row.length - 1);
        break;
      }
      if (removed) {
        await ctx.reply('✅ Кнопка удалена.');
      } else {
        await ctx.reply('⚠️ В этом сообщении нет кнопок для удаления.');
      }
      await showSettingsFirstMessageButtonsMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'first_button_row') {
      const service = activeModerationService || defaultModerationService;
      const rowIndex = Number(parsed.value || 0);
      const rows = service.getMenuButtons(chatId);
      const row = Array.isArray(rows[rowIndex]) ? rows[rowIndex] : [];
      const rowLabel = row.length ? row.map((item) => item.text).join(', ') : 'пусто';
      await ctx.editMessageText(`Ряд ${rowIndex + 1}: ${rowLabel}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Добавить кнопку в ряд', callback_data: `settings:first_button_add:${chatId}:${rowIndex}` }],
            [{ text: 'Удалить ряд', callback_data: `settings:first_button_remove_row:${chatId}:${rowIndex}` }],
            [{ text: 'Назад', callback_data: `settings:first_buttons:${chatId}` }],
          ],
        },
      });
      return;
    }

    if (parsed.target === 'first_media') {
      setPendingSettingsAction(ctx, { action: 'settings_message_media', groupId: chatId });
      await ctx.reply('Отправьте медиа для первого сообщения.');
      return;
    }

    if (parsed.target === 'first_remove_media') {
      moderationService.setMenuMedia(chatId, null);
      await ctx.reply('✅ Медиа удалено.');
      await showSettingsFirstMessageMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'rules_edit' || parsed.target === 'rules_add') {
      setPendingSettingsAction(ctx, { action: 'settings_rules_set', groupId: chatId });
      await ctx.reply(parseSettingsPrompt('settings_rules_set'));
      return;
    }

    if (parsed.target === 'rules_clear') {
      moderationService.setRules(chatId, '');
      await ctx.reply('✅ Правила очищены.');
      await showSettingsRulesMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'rules_view') {
      const rules = moderationService.getRules(chatId);
      await ctx.editMessageText(rules || 'Правила ещё не заданы.', { reply_markup: buildSettingsRulesKeyboard(chatId) });
      return;
    }

    if (parsed.target === 'banword_mode') {
      const service = activeModerationService || defaultModerationService;
      const mode = String(parsed.value || '').toLowerCase();
      if (['off', 'warn', 'mute', 'ban'].includes(mode)) {
        service.setBanwordPunishmentMode(chatId, mode);
      }
      await showSettingsBanwordsMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'banword_delete') {
      const service = activeModerationService || defaultModerationService;
      service.setBanwordDeleteMessages(chatId, !service.getBanwordDeleteMessages(chatId));
      await showSettingsBanwordsMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'banword_add') {
      await safeAnswerCbQuery(ctx);
      setPendingSettingsAction(ctx, { action: 'settings_banword_add', groupId: chatId });
      await ctx.reply(parseSettingsPrompt('settings_banword_add'));
      return;
    }

    if (parsed.target === 'banword_remove') {
      await safeAnswerCbQuery(ctx);
      setPendingSettingsAction(ctx, { action: 'settings_banword_remove', groupId: chatId });
      await ctx.reply(parseSettingsPrompt('settings_banword_remove'));
      return;
    }

    if (parsed.target === 'banword_list') {
      await showSettingsBanwordsListMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'banword_list_back') {
      await showSettingsBanwordsMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'warn_menu') {
      await showSettingsWarnsMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'warn_mode') {
      const service = activeModerationService || defaultModerationService;
      const mode = String(parsed.value || '').toLowerCase();
      if (['off', 'kick', 'mute', 'ban'].includes(mode)) {
        service.setWarnPunishmentMode(chatId, mode);
      }
      await showSettingsWarnsMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'warn_limit_menu') {
      const text = [
        '⚠️ Выберите лимит предупреждений',
        '',
        'Когда пользователь достигнет этого количества предупреждений,',
        'будет применено выбранное наказание.',
      ].join('\n');
      await safeEditMessageText(ctx, text, { reply_markup: buildSettingsWarnsLimitKeyboard(chatId) });
      return;
    }

    if (parsed.target === 'warn_limit') {
      const service = activeModerationService || defaultModerationService;
      const limit = Number(parsed.value);
      if (Number.isFinite(limit) && limit >= 2 && limit <= 6) {
        service.setWarnLimit(chatId, limit);
      }
      await showSettingsWarnsMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'warn_duration_menu') {
      const text = [
        '⏱️ Выберите время бана',
        '',
        'Это время будет использоваться, когда пользователь достигает лимита предупреждений.',
      ].join('\n');
      await safeEditMessageText(ctx, text, { reply_markup: buildSettingsWarnsDurationKeyboard(chatId) });
      return;
    }

    if (parsed.target === 'warn_duration') {
      const service = activeModerationService || defaultModerationService;
      const duration = Number(parsed.value);
      if (Number.isFinite(duration) && duration >= 0) {
        const saved = service.setWarnBlockDuration(chatId, duration);
        if (saved) {
          const durationText = duration === 0 ? '∞ Навсегда' : `${duration}ч`;
          await replyWithAutoDelete(ctx, `✅ Время бана установлено: ${durationText}`);
        } else {
          await replyWithAutoDelete(ctx, '⚠️ Ошибка при установке времени бана');
        }
      }
      await showSettingsWarnsMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'warn_duration_custom') {
      setPendingSettingsAction(ctx, { action: 'settings_warn_duration_custom', groupId: chatId });
      await ctx.reply('✍️ Напишите время бана в одном из форматов:\nПримеры: 1ч, 2ч, 1д, 7д, 1мес, 1год');
      return;
    }

    if (parsed.target === 'warn_list') {
      await showSettingsWarnsListMenu(ctx, chatId);
      return;
    }

    if (parsed.target === 'warn_amnesty') {
      const text = [
        '⚠️ Подтверждение амнистии',
        '',
        'Сбросить все предупреждения всем участникам этого чата?',
      ].join('\n');
      await safeEditMessageText(ctx, text, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Точно обнулить варны', callback_data: `settings:warn_amnesty_confirm:${chatId}` },
              { text: '❌ Нет', callback_data: `settings:warn_menu:${chatId}` },
            ],
          ],
        },
      });
      return;
    }

    if (parsed.target === 'warn_amnesty_confirm') {
      const service = activeModerationService || defaultModerationService;
      service.resetAllWarnings(chatId);
      await showSettingsWarnsMenu(ctx, chatId);
      return;
    }
  });

  bot.action(/^admin_report:(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    await safeAnswerCbQuery(ctx);
    const parts = String(action || '').split(':').filter(Boolean);
    if (parts[0] !== 'accept') {
      return;
    }

    const reportChatId = Number(parts[1] || ctx.chat?.id || 0);
    const reportId = parts[2] || '';
    if (!Number.isFinite(reportChatId) || !reportId) {
      return;
    }

    if (!isBotAdmin(ctx)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const report = adminReports.get(reportId);
    if (!report || Number(report.chatId) !== reportChatId) {
      await ctx.reply('Эта жалоба больше недоступна.');
      return;
    }

    const acceptor = {
      id: ctx.from.id,
      username: ctx.from.username,
      first_name: ctx.from.first_name,
    };

    // mark as accepted but keep the report until moderator provides a written report
    report.acceptedBy = acceptor;
    report.acceptedAt = Date.now();
    report.status = 'accepted';

    const acceptedText = formatAdminReportText(report, acceptor) + '\n\n✍️ Модератор, пожалуйста, напишите отчёт по этой жалобе.';

    // edit the message where the moderator clicked to remove buttons
    try {
      await ctx.editMessageText(acceptedText);
    } catch (error) {
      // ignore
    }

    // edit any other notification messages (origin/admin group) to remove buttons and show accepted text
    try {
      if (Array.isArray(report.notifications)) {
        for (const note of report.notifications) {
          try {
            // skip editing the message in the same chat if it's the one we already edited
            if (note.chatId === ctx.chat.id && note.messageId === ctx.callbackQuery?.message?.message_id) {
              continue;
            }
            await ctx.telegram.editMessageText(note.chatId, note.messageId, null, acceptedText);
          } catch (err) {
            // ignore per-message errors
          }
        }
      }
    } catch (err) {
      // ignore
    }

    // set pending action so the moderator can write the report text; scope to moderator user in current chat
    const promptMessage = await ctx.reply('Напишите краткий отчёт по жалобе. После отправки ваше сообщение будет удалено и включено в уведомление.');
    setPendingSettingsAction(ctx, { action: 'admin_report_write', reportId, groupId: ctx.chat.id, promptMessageId: promptMessage.message_id });
    return;
  });

  bot.action(/^stats:clear_history:(-?\d+):(\d+)$/, async (ctx) => {
    const chatId = Number(ctx.match[1]);
    const targetUserId = Number(ctx.match[2]);
    await safeAnswerCbQuery(ctx, 'Сброс истории наказаний...');

    if (!Number.isFinite(chatId) || !Number.isFinite(targetUserId)) {
      return;
    }

    if (!isBotAdmin(ctx)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    if (!canUseBotAdminAction(ctx, 'clear_history')) {
      await ctx.reply('Эта команда доступна только админам уровня «Ведущий» и выше.');
      return;
    }

    if (!ensureBotAdminCanPunishTarget(ctx, targetUserId, 'clear_history')) {
      return;
    }

    database.clearUserPunishmentHistory(chatId, targetUserId);
    moderationService.resetWarnings(chatId, targetUserId);
    await ctx.reply(`✅ История наказаний пользователя ${targetUserId} сброшена.`);
  });

  bot.action(/^menu:(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }
    await safeAnswerCbQuery(ctx);

    const botMessageMatch = String(action).match(/^bot_message(?::(-?\d+))?$/);
    const botMessageChatId = botMessageMatch ? Number(botMessageMatch[1] || chatId) : 0;
    if (botMessageMatch) {
      if (!(await canManageGroupSettings(ctx, botMessageChatId))) {
        await ctx.reply('У вас нет прав администратора группы с правом менять профиль группы.');
        return;
      }
    } else if (!isBotAdmin(ctx)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    if (action === 'overview' || action === 'first_message') {
      await ctx.editMessageText(formatMenuOverview(chatId), { reply_markup: getMenuKeyboard(chatId) });
      return;
    }

    if (action === 'chat') {
      const service = activeModerationService || defaultModerationService;
      const mode = service.getChatAccessMode(chatId);
      const labels = {
        open: '📖 Открыт — все могут писать',
        closed: '🔒 Закрыт — писать нельзя',
        admins: '👥 Только администраторы могут писать',
        owner: '👑 Только владелец группы может писать',
      };

      const text = [
        '💬 Настройки чата',
        '',
        `Текущий режим: ${labels[mode] || labels.open}`,
        '',
        '• Открыть чат — все могут писать',
        '• Закрыть чат — никто не может писать, даже администраторы',
        '• Только админы — писать могут администраторы и владелец',
        '• Только владелец — писать может только владелец группы',
      ].join('\n');

      await ctx.editMessageText(text, { reply_markup: buildSettingsChatKeyboard(chatId) });
      return;
    }

    if (action === 'mention') {
      await showMentionNotificationMenu(ctx, chatId);
      return;
    }

    if (action.startsWith('mention_toggle:')) {
      const parts = String(action).split(':');
      const enabledText = parts[1] || 'off';
      const targetChatId = parts[2] || String(chatId);
      const source = parts[3] || 'menu';
      const targetId = Number(targetChatId) || chatId;
      const service = activeModerationService || defaultModerationService;
      const nextEnabled = String(enabledText).toLowerCase() === 'on';
      service.setMentionNotificationsEnabled(targetId, nextEnabled);
      await safeAnswerCbQuery(ctx, nextEnabled ? '✅ Уведомления включены' : '❌ Уведомления отключены');
      await showMentionNotificationMenu(ctx, targetId, source);
      return;
    }

    if (action.startsWith('chat_access:')) {
      const [, , mode = ''] = String(action).split(':');
      const service = activeModerationService || defaultModerationService;
      if (service.setChatAccessMode(chatId, mode)) {
        const labels = {
          open: '✅ Открыт',
          closed: '✅ Закрыт',
          admins: '✅ Только администраторы',
          owner: '✅ Только владелец',
        };
        await safeAnswerCbQuery(ctx, labels[mode] || '✅ Режим изменён');
      } else {
        await safeAnswerCbQuery(ctx, '⚠️ Неверный режим');
      }
      await ctx.editMessageText(
        [
          '💬 Настройки чата',
          '',
          `Текущий режим: ${service.getChatAccessMode(chatId) === 'open' ? '📖 Открыт — все могут писать' : service.getChatAccessMode(chatId) === 'closed' ? '🔒 Закрыт — писать нельзя' : service.getChatAccessMode(chatId) === 'admins' ? '👥 Только администраторы могут писать' : '👑 Только владелец группы может писать'}`,
          '',
          '• Открыть чат — все могут писать',
          '• Закрыть чат — никто не может писать, даже администраторы',
          '• Только админы — писать могут администраторы и владелец',
          '• Только владелец — писать может только владелец группы',
        ].join('\n'),
        { reply_markup: buildSettingsChatKeyboard(chatId) }
      );
      return;
    }

    if (action === 'members') {
      await showMembersManagementMenu(ctx, chatId);
      return;
    }

    if (action.startsWith('members:')) {
      const [, , specificAction] = String(action).split(':');
      if (specificAction === 'unrestrict_all') {
        await ctx.reply('⚠️ Функция "Снять запрет всем" доступна при поддержке Telegram API для массового снятия ограничений.');
        await showMembersManagementMenu(ctx, chatId);
        return;
      }
      if (specificAction === 'unban_all') {
        await ctx.reply('⚠️ Функция "Всех разблокировать" доступна при поддержке Telegram API для массовой разблокировки.');
        await showMembersManagementMenu(ctx, chatId);
        return;
      }
      if (specificAction === 'remove_restricted') {
        await ctx.reply('⚠️ Функция "Исключить ограниченных пользователей" требует массового списка ограничений, который Telegram API не предоставляет напрямую.');
        await showMembersManagementMenu(ctx, chatId);
        return;
      }
      if (specificAction === 'remove_deleted') {
        await ctx.reply('⚠️ Функция "Исключить удалённые аккаунты" требует отдельной проверки участников и доступна при расширенной интеграции с Telegram API.');
        await showMembersManagementMenu(ctx, chatId);
        return;
      }
    }

    if (action === 'text') {
      setPendingMenuAction(ctx, { action: 'text' });
      await ctx.reply(getMenuActionInstructions('text'));
      return;
    }

    if (action === 'buttons') {
      await ctx.editMessageText(formatMenuOverview(chatId), { reply_markup: buildMenuButtonsKeyboard(chatId) });
      return;
    }

    if (action === 'media') {
      setPendingMenuAction(ctx, { action: 'media' });
      await ctx.reply(getMenuActionInstructions('media'));
      return;
    }

    if (botMessageMatch) {
      setPendingMenuAction(ctx, { action: 'bot_message', groupId: botMessageChatId });
      await ctx.reply('📝 Напишите сообщение, которое бот отправит в эту группу. Можно использовать любые ссылки, эмодзи, символы и форматирование.');
      return;
    }

    if (action === 'add_row') {
      moderationService.addMenuRow(chatId);
      await ctx.reply('✅ Ряд добавлен.');
      await ctx.editMessageText(formatMenuOverview(chatId), { reply_markup: buildMenuButtonsKeyboard(chatId) });
      return;
    }

    if (action === 'remove_row') {
      const rowIndex = Number(action.split(':')[1]);
      if (Number.isFinite(rowIndex) && moderationService.removeMenuRow(chatId, rowIndex)) {
        await ctx.reply(`✅ Ряд ${rowIndex + 1} удалён.`);
      } else {
        await ctx.reply('⚠️ Не удалось удалить ряд. Проверьте номер.');
      }
      await ctx.editMessageText(formatMenuOverview(chatId), { reply_markup: buildMenuButtonsKeyboard(chatId) });
      return;
    }

    if (action.startsWith('add_button:')) {
      const rowIndex = Number(action.split(':')[1]);
      if (!Number.isFinite(rowIndex)) {
        await ctx.reply('⚠️ Неверный ряд.');
        return;
      }
      setPendingMenuAction(ctx, { action: 'button_add', rowIndex });
      await ctx.reply('Отправьте новую кнопку в формате: Название | URL');
      return;
    }

    if (action === 'clear_buttons') {
      moderationService.clearMenuButtons(chatId);
      await ctx.reply('✅ Все кнопки удалены.');
      await ctx.editMessageText(formatMenuOverview(chatId), { reply_markup: getMenuKeyboard(chatId) });
      return;
    }

    if (action.startsWith('remove_button:')) {
      const parts = action.split(':');
      const rowIndex = Number(parts[1]);
      const buttonIndex = Number(parts[2]);
      if (Number.isFinite(rowIndex) && Number.isFinite(buttonIndex)) {
        if (moderationService.removeMenuButton(chatId, rowIndex, buttonIndex)) {
          await ctx.reply(`✅ Кнопка ${buttonIndex + 1} из ряда ${rowIndex + 1} удалена.`);
        } else {
          await ctx.reply('⚠️ Не удалось удалить кнопку. Проверьте номер ряда и кнопку.');
        }
      }
      await ctx.editMessageText(formatMenuOverview(chatId), { reply_markup: buildMenuButtonsKeyboard(chatId) });
      return;
    }

    if (action.startsWith('row_info:')) {
      const rowIndex = Number(action.split(':')[1]);
      if (!Number.isFinite(rowIndex)) {
        await ctx.reply('⚠️ Неверный ряд.');
        return;
      }
      await ctx.editMessageText(formatMenuOverview(chatId), { reply_markup: buildMenuRowInfoKeyboard(chatId, rowIndex) });
      return;
    }

    if (action === 'command_rights') {
      await showMenuCommandRightsMenu(ctx, chatId, 0, 'menu:overview', 'menu');
      return;
    }

    if (action === 'command_rights:sections' || action === 'command_rights:sections:settings') {
      const returnFlag = action.endsWith(':settings') ? 'settings' : 'menu';
      await ctx.editMessageText(buildCommandSectionsText(chatId), { reply_markup: buildCommandSectionsKeyboard(chatId, returnFlag) });
      return;
    }

    if (action.startsWith('command_rights:commands:')) {
      const parts = action.split(':');
      const pageIndex = Number(parts[3]);
      const returnFlag = parts.includes('settings') ? 'settings' : 'menu';
      const returnCallback = returnFlag === 'settings' ? `settings:main:${chatId}` : 'menu:overview';
      if (Number.isFinite(pageIndex)) {
        await showMenuCommandRightsMenu(ctx, chatId, pageIndex, returnCallback, returnFlag);
      }
      return;
    }

    if (action.startsWith('command_rights:st:')) {
      const parts = action.split(':');
      const sectionId = parts[3];
      const mode = parts[4];
      const returnFlag = parts.includes('settings') ? 'settings' : 'menu';
      const section = getCommandSections().find((item) => item.id === sectionId);
      if (!section || !['enable', 'disable'].includes(mode)) {
        return;
      }
      section.commands.forEach(({ cmd }) => moderationService.setCommandDisabled(chatId, cmd, mode === 'disable'));
      await safeAnswerCbQuery(ctx, mode === 'disable' ? `❌ Раздел ${section.label} отключён.` : `✅ Раздел ${section.label} включён.`);
      await ctx.editMessageText(buildCommandSectionsText(chatId), { reply_markup: buildCommandSectionsKeyboard(chatId, returnFlag) });
      return;
    }

    if (action.startsWith('command_rights:nav:')) {
      const parts = action.split(':');
      const pageIndex = Number(parts[2]);
      const returnFlag = parts.includes('settings') ? 'settings' : 'menu';
      const returnCallback = returnFlag === 'settings' ? `settings:main:${chatId}` : 'menu:overview';
      if (Number.isFinite(pageIndex)) {
        await showMenuCommandRightsMenu(ctx, chatId, pageIndex, returnCallback, returnFlag);
      }
      return;
    }

    if (action.startsWith('command_rights:disable:') || action.startsWith('command_rights:enable:')) {
      const parts = action.split(':');
      const commandIndex = Number(parts[2]);
      const enable = action.startsWith('command_rights:enable:');
      const commands = getCommandsList();
      const returnFlag = parts.includes('settings') ? 'settings' : 'menu';
      const returnCallback = returnFlag === 'settings' ? `settings:main:${chatId}` : 'menu:overview';

      if (Number.isFinite(commandIndex) && commandIndex >= 0 && commandIndex < commands.length) {
        const { cmd, label } = commands[commandIndex];
        moderationService.setCommandDisabled(chatId, cmd, !enable);
        await safeAnswerCbQuery(ctx, `✅ Команда ${label} ${enable ? 'включена' : 'отключена'}.`);
        const pageIndex = Math.floor(commandIndex / COMMANDS_PER_PAGE);
        await showMenuCommandRightsMenu(ctx, chatId, pageIndex, returnCallback, returnFlag);
      }
      return;
    }
  });

  bot.command(['id', 'айди'], (ctx) => {
    ctx.reply(`Ваш Telegram ID: ${ctx.from.id}`);
  });

  bot.command(['about', 'информация'], (ctx) => {
    ctx.reply(`${config.botName}\nПолноценный бот на Node.js.`);
  });

  bot.command('admincom', async (ctx) => {
    await adminPunishmentCommandsCommand(ctx);
  });

  bot.command(['whoami', 'кто_я'], (ctx) => {
    ctx.reply(`${ctx.from.first_name || 'Пользователь'}, ${getFunnyDescription()}`);
  });

  bot.command(['stats', 'статистика'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:stats|статистика)(?:@[\w_]+)?\s*/i, '');
    await statsCommand(ctx, args);
  });

  bot.command(['rules', 'правила'], (ctx) => {
    rulesCommand(ctx);
  });

  bot.command(['hug', 'обнять'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:hug|обнять)\s*/i, '');
    await roleplayCommand(ctx, args, 'hug');
  });

  bot.command(['kiss', 'поцеловать'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:kiss|поцеловать)\s*/i, '');
    await roleplayCommand(ctx, args, 'kiss');
  });

  bot.command(['slap', 'шлепнуть'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:slap|шлепнуть)\s*/i, '');
    await roleplayCommand(ctx, args, 'slap');
  });

  bot.command(['poke', 'тыкнуть'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:poke|тыкнуть)\s*/i, '');
    await roleplayCommand(ctx, args, 'poke');
  });

  bot.command(['fuck', 'вьебать', 'выебать'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:fuck|вьебать|выебать)\s*/i, '');
    await roleplayCommand(ctx, args, 'fuck');
  });

  bot.command(['rape', 'трахнуть'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:rape|трахнуть)\s*/i, '');
    await roleplayCommand(ctx, args, 'rape');
  });

  bot.command(['beat', 'уебать'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:beat|уебать)\s*/i, '');
    await roleplayCommand(ctx, args, 'beat');
  });

  bot.command(['kill', 'убить'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:kill|убить)\s*/i, '');
    await roleplayCommand(ctx, args, 'kill');
  });

  bot.command(['bite', 'укусить'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:bite|укусить)\s*/i, '');
    await roleplayCommand(ctx, args, 'bite');
  });

  bot.command(['lick', 'лизнуть'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:lick|лизнуть)\s*/i, '');
    await roleplayCommand(ctx, args, 'lick');
  });

  bot.command(['lickup', 'отлизать'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:lickup|отлизать)\s*/i, '');
    await roleplayCommand(ctx, args, 'lickup');
  });

  bot.command(['ai'], async (ctx) => {
    const text = ctx.message.text.replace(/^\/ai\s*/i, '').trim();
    await aiCommand(ctx, text);
  });

  bot.command(['coin', 'монетка'], (ctx) => {
    funCommand(ctx, 'coin');
  });

  bot.command(['dice', 'кубик'], (ctx) => {
    funCommand(ctx, 'dice');
  });

  bot.command(['fate', 'вопрос'], (ctx) => {
    funCommand(ctx, 'fate');
  });

  bot.command(['compliment', 'комплимент'], (ctx) => {
    funCommand(ctx, 'compliment');
  });

  bot.command(['insult', 'инсульт'], (ctx) => {
    funCommand(ctx, 'insult');
  });

  bot.command(['top', 'топ'], topCommand);

  bot.command(['admins', 'админы'], (ctx) => {
    listBotAdminsCommand(ctx);
  });

  bot.command(['clearhistory', 'сбросистории', 'сброс_истории', 'clear_history'], async (ctx, next) => {
    const args = ctx.message.text.replace(/^\/clearhistory(?:@\w+)?\s*/i, '').trim();
    await clearUserPunishmentHistoryCommand(ctx, args || ctx.message.text.replace(/^\/(?:clearhistory|сбросистории|сброс_истории|clear_history)(?:@\w+)?\s*/i, ''));
  });

  bot.command(['banlist', 'баны'], (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:banlist|баны)\s*/i, '');
    listPunishmentsCommand(ctx, 'ban', args);
  });

  bot.command(['mutelist', 'муты'], (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:mutelist|муты)\s*/i, '');
    listPunishmentsCommand(ctx, 'mute', args);
  });

  bot.command(['menu'], async (ctx) => {
    if (ctx.chat?.type === 'private') {
      const managedGroups = await getManagedGroupsForUser(ctx);
      if (!managedGroups.length) {
        await ctx.reply('У вас нет групп, где вы можете менять настройки бота.');
        return;
      }

      await showSettingsGroupSelector(ctx);
      return;
    }

    const chatId = Number(ctx.chat?.id || 0);
    if (!chatId) {
      return;
    }

    if (!(await canManageGroupSettings(ctx, chatId))) {
      await ctx.reply('У вас нет прав администратора группы с правом менять профиль группы.');
      return;
    }

    await openSettingsForCurrentContext(ctx, chatId);
  });

  bot.command(['miniapp', 'миниприложение'], async (ctx) => {
    const chatId = Number(ctx.chat?.id || 0);
    if (!chatId) {
      return;
    }

    if (!(await canManageGroupSettings(ctx, chatId))) {
      await ctx.reply('У вас нет прав администратора группы с правом менять профиль группы.');
      return;
    }

    const port = getMiniAppPort();
    const url = detectPublicMiniAppUrl(config, port);
    await ctx.reply('Открыл мини-приложение для настроек группы.', {
      reply_markup: {
        inline_keyboard: [[{
          text: 'Открыть настройки',
          web_app: { url: `${url}/?chat_id=${chatId}` },
        }]],
      },
    });
  });

  bot.command(['allowed'], (ctx) => {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    const allowedLinks = moderationService.getAllowedLinks(ctx.chat.id);
    if (!allowedLinks.length) {
      ctx.reply('В чате нет разрешённых ссылок. Используйте +links <url>, чтобы добавить.');
      return;
    }
    const message = ['Разрешённые ссылки и домены:'];
    for (const item of allowedLinks) {
      message.push(item);
    }
    ctx.reply(message.join('\n'));
  });

  bot.command(['links', 'ссылки'], (ctx) => {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    const args = ctx.message.text.replace(/^\/(?:links|ссылки)(?:@[\w_]+)?\s*/i, '').trim();
    if (!args) {
      ctx.reply('Использование: /links <url> — добавить разрешённую ссылку или домен.');
      return;
    }
    if (moderationService.addAllowedLink(ctx.chat.id, args)) {
      ctx.reply(`✅ Разрешённая ссылка добавлена: ${args}`);
    } else {
      ctx.reply('Эта ссылка уже добавлена или формат некорректен.');
    }
  });

  bot.on('my_chat_member', async (ctx) => {
    const newStatus = ctx.update.my_chat_member.new_chat_member.status;
    if (newStatus === 'member' || newStatus === 'administrator') {
      await ensureGroupOwner(ctx);
    }
  });

  bot.on('new_chat_title', (ctx) => {
    if (!ctx.chat || !ctx.message?.new_chat_title) {
      return;
    }

    database.ensureGroup(ctx.chat.id, ctx.message.new_chat_title);
  });

  bot.on('chat_member', async (ctx) => {
    const member = ctx.chatMember?.new_chat_member;
    if (!member || !ctx.chat) {
      return;
    }

    const isBot = Boolean(member.user?.is_bot);
    if (isBot) {
      return;
    }

    const userId = Number(member.user?.id);
    if (!Number.isFinite(userId)) {
      return;
    }

    await startCaptchaForUser(ctx, userId, member.user);
  });

  bot.on('new_chat_members', async (ctx) => {
    const newMembers = ctx.message?.new_chat_members;
    if (!Array.isArray(newMembers) || !ctx.chat) {
      return;
    }

    for (const member of newMembers) {
      if (member.is_bot) {
        continue;
      }
      const userId = Number(member.id);
      if (!Number.isFinite(userId)) {
        continue;
      }
      await startCaptchaForUser(ctx, userId, member);
    }
  });

  bot.on('poll_answer', async (ctx) => {
    const pollAnswer = ctx.update.poll_answer;
    if (!pollAnswer || !pollAnswer.poll_id || !pollAnswer.user) {
      return;
    }

    const agreementState = agreementStates.get(pollAnswer.poll_id);
    if (agreementState) {
      const userId = Number(pollAnswer.user.id);
      if (!Number.isFinite(userId) || userId !== agreementState.userId || pollAnswer.user.is_bot) {
        return;
      }

      const selectedOption = (pollAnswer.option_ids || [])[0];
      agreementStates.delete(pollAnswer.poll_id);

      if (selectedOption === 0) {
        await handleAgreementDecision(ctx.telegram, agreementState, true);
        return;
      }

      await handleAgreementDecision(ctx.telegram, agreementState, false);
      return;
    }

    const state = captchaStates.get(pollAnswer.poll_id);
    if (!state) {
      return;
    }

    const userId = Number(pollAnswer.user.id);
    if (!Number.isFinite(userId) || userId !== state.userId || pollAnswer.user.is_bot) {
      return;
    }

    const selectedOption = (pollAnswer.option_ids || [])[0];
    const passed = selectedOption === state.correctOptionId;
    await completeCaptcha(ctx, pollAnswer.poll_id, passed);
  });

  bot.command(['setrules', 'установить_правила'], (ctx) => {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    const text = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
    if (!text) {
      ctx.reply('Использование: /setrules текст правил');
      return;
    }
    moderationService.setRules(ctx.chat.id, text);
    ctx.reply('Правила чата обновлены.');
  });

  bot.command(['warn', 'предупреждение'], async (ctx) => {
    await warnCommand(ctx, ctx.message.text.replace(/^\/(?:warn|предупреждение)\s*/i, ''));
  });

  bot.command('delwarn', async (ctx) => {
    await warnCommand(ctx, ctx.message.text.replace(/^\/delwarn(?:@[\w_]+)?\s*/i, ''), true);
  });

  bot.command(['warnings', 'варны'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:warnings|варны)(?:@[\w_]+)?\s*/i, '');
    await warningsCommand(ctx, args);
  });

  bot.command(['unwarn', 'снять_предупреждение'], async (ctx) => {
    await unwarnCommand(ctx, ctx.message.text.replace(/^\/(?:unwarn|снять_предупреждение)\s*/i, ''));
  });

  bot.command(['mute', 'мут'], async (ctx) => {
    await muteCommand(ctx, ctx.message.text.replace(/^\/(?:mute|мут)\s*/i, ''));
  });

  bot.command('delmute', async (ctx) => {
    await muteCommand(ctx, ctx.message.text.replace(/^\/delmute(?:@[\w_]+)?\s*/i, ''), true);
  });

  bot.command(['unmute', 'размут'], async (ctx) => {
    await unmuteCommand(ctx, ctx.message.text.replace(/^\/(?:unmute|размут)\s*/i, ''));
  });

  bot.command(['ban', 'бан'], async (ctx) => {
    await banCommand(ctx, ctx.message.text.replace(/^\/(?:ban|бан)\s*/i, ''));
  });

  bot.command('delban', async (ctx) => {
    await delBanCommand(ctx, ctx.message.text.replace(/^\/delban(?:@[\w_]+)?\s*/i, ''));
  });

  bot.command(['unban', 'разбан'], async (ctx) => {
    await unbanCommand(ctx, ctx.message.text.replace(/^\/(?:unban|разбан)\s*/i, ''));
  });

  bot.command(['setgreeting', 'установить_приветствие'], (ctx) => {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    const text = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
    if (!text) {
      ctx.reply('Использование: /setgreeting текст приветствия');
      return;
    }
    moderationService.setGreeting(ctx.chat.id, text);
    ctx.reply('Приветствие чата обновлено.');
  });

  bot.command(['addadmin', 'добавить_админа'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:addadmin|добавить_админа)(?:@[\w_]+)?\s*/i, '');
    await addBotAdminCommand(ctx, args);
  });

  bot.command(['removeadmin', 'снять_админа'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:removeadmin|снять_админа)(?:@[\w_]+)?\s*/i, '');
    await removeBotAdminCommand(ctx, args);
  });

  async function handleIncomingMessage(ctx) {
    const message = ctx.message;
    if (!message) {
      return;
    }

    const text = getMessageText(ctx);
    const lowerText = text.toLowerCase();
    const hasMessageContent = Boolean(text || isMediaMessage(ctx));
    if (!hasMessageContent) {
      return;
    }

    if (isGroupChat(ctx)) {
      const service = activeModerationService || defaultModerationService;
      const chatId = ctx.chat.id;

      if (service.isMentionNotificationsEnabled(chatId)) {
        try {
          const mentionTargets = new Set();
          const mentionPattern = /@([A-Za-z0-9_]{3,32})/g;
          const mentionedUsernames = [...text.matchAll(mentionPattern)].map((match) => match[1].toLowerCase());

          for (const username of mentionedUsernames) {
            const resolved = database.resolveUsername(chatId, username);
            if (resolved && Number.isFinite(Number(resolved.userId))) {
              mentionTargets.add(Number(resolved.userId));
            }
          }

          if (message.entities) {
            for (const entity of message.entities) {
              if (entity.type === 'text_mention' && entity.user?.id) {
                mentionTargets.add(Number(entity.user.id));
              }
            }
          }

          for (const targetUserId of mentionTargets) {
            if (targetUserId === Number(ctx.from.id)) {
              continue;
            }

            if (!userService.hasUser(targetUserId)) {
              continue;
            }

            const targetMember = await ctx.telegram.getChatMember(chatId, targetUserId).catch(() => null);
            if (!targetMember || !targetMember.user) {
              continue;
            }

            const mentionerText = getMentionText(ctx.from || { id: ctx.from.id, username: ctx.from.username });
            const chatTitle = ctx.chat.title || 'группа';
            const messageLink = (() => {
              const messageId = Number(message.message_id || 0);
              if (!messageId) {
                return null;
              }

              const chatUsername = String(ctx.chat.username || '').trim();
              if (chatUsername) {
                return `https://t.me/${chatUsername}/${messageId}`;
              }

              const chatIdNumber = Number(ctx.chat.id || 0);
              if (chatIdNumber) {
                const normalized = String(Math.abs(chatIdNumber)).replace(/^100/, '');
                return `https://t.me/c/${normalized}/${messageId}`;
              }

              return null;
            })();

            const notificationText = [
              'Вас упомянули в чате',
              `Кто: ${mentionerText}`,
              `В чате: «${chatTitle}»`,
            ].join('\n');

            const replyMarkup = messageLink ? {
              inline_keyboard: [[{ text: 'Посмотреть сообщение', url: messageLink }]],
            } : undefined;

            try {
              await ctx.telegram.sendMessage(targetUserId, notificationText, { reply_markup: replyMarkup });
            } catch (error) {
              // ignore if user blocked the bot or has no access to DMs
            }
          }
        } catch (error) {
          // ignore mention notification errors
        }
      }

      let isOwner = Number(ctx.chat.owner_id) === Number(ctx.from.id);
      let isAdmin = false;
      try {
        const member = await ctx.telegram.getChatMember(chatId, ctx.from.id);
        isOwner = isOwner || isGroupOwnerMember(member);
        isAdmin = Boolean(member && (member.status === 'administrator' || member.status === 'creator'));
      } catch (error) {
        isAdmin = false;
      }

      const allowedToWrite = moderationService.canWriteInChat(chatId, ctx.from.id, isOwner, isAdmin);
      if (!allowedToWrite) {
        try {
          await deleteMessageSafely(ctx, message.message_id);
        } catch (error) {
          // ignore delete failures
        }

        const modeLabel = moderationService.getChatAccessMode(chatId);
        const reasonText = modeLabel === 'admins'
          ? 'Писать могут только администраторы.'
          : modeLabel === 'owner'
            ? 'Писать может только владелец группы.'
            : 'Чат закрыт. Все сообщения удаляются.';

        try {
          await replyWithAutoDelete(ctx, `🚫 ${reasonText}`, {}, 2000);
        } catch (error) {
          // ignore reply failures for blocked messages
        }
        return;
      }

      database.recordMessage(chatId, ctx.from.id, getDisplayName(ctx), ctx.from.username);
    }

    // Handle anonymous messages (sender_chat/author_signature) - messages posted through a channel or hidden sender
    if (isGroupChat(ctx) && isAnonymousSenderMessage(message)) {
      const service = activeModerationService || defaultModerationService;
      if (service.isHideAnonymousEnabled(ctx.chat.id)) {
        if (service.shouldDeleteAnonymousMessages(ctx.chat.id)) {
          try {
            queueBulkModerationSummary(ctx, ctx.from.id, 'Скрытый отправитель');
            await deleteMessageSafely(ctx, message.message_id);
          } catch (error) {
            console.warn('Failed to delete anonymous message:', error?.message || error);
          }
        }
        return;
      }
    }

    // Handle forwarded messages
    if (isGroupChat(ctx)) {
      const forwardCategory = detectForwardedMessageCategory(message);
      if (forwardCategory) {
        const service = activeModerationService || defaultModerationService;
        const settings = service.getForwardsSettings(ctx.chat.id, forwardCategory);

        console.log(`[Forward Debug] Detected forward in chat ${ctx.chat.id}:`, {
          category: forwardCategory,
          deleteMessage: settings.deleteMessage,
          punishmentMode: settings.punishmentMode,
          userId: ctx.from.id,
        });

        const reason = `Пересланное сообщение от ${forwardCategory === 'channels' ? 'канала' : forwardCategory === 'groups' ? 'группы' : forwardCategory === 'bots' ? 'бота' : 'пользователя'}`;

        // Delete message if deletion is enabled (regardless of punishment mode)
        if (settings.deleteMessage) {
          try {
            queueBulkModerationSummary(ctx, ctx.from.id, `Пересланное сообщение из ${forwardCategory === 'channels' ? 'канала' : forwardCategory === 'groups' ? 'группы' : forwardCategory === 'bots' ? 'бота' : 'пользователя'}`);
            await deleteMessageSafely(ctx, message.message_id);
            console.log(`[Forward] Deleted ${forwardCategory} forward in chat ${ctx.chat.id} from user ${ctx.from.id}`);
          } catch (error) {
            console.warn('Failed to delete forwarded message:', error?.message || error);
          }
        }

        // Apply punishment based on mode
        if (settings.punishmentMode === 'warn') {
            moderationService.addWarning(ctx.chat.id, ctx.from.id);
            database.addPunishment(ctx.chat.id, ctx.from.id, 'warn', reason, null);
            const warningCount = moderationService.getWarnings(ctx.chat.id, ctx.from.id);
            const warnLimit = moderationService.getWarnLimit(ctx.chat.id);
            const userLabel = getMentionText(ctx.from || { id: ctx.from.id });
            
            if (warningCount >= warnLimit) {
              // Auto-ban after reaching limit
              const blockDuration = moderationService.getWarnBlockDuration(ctx.chat.id);
              const untilDate = Math.floor(Date.now() / 1000) + Math.round(blockDuration * 3600);
              try {
                await ctx.telegram.banChatMember(ctx.chat.id, ctx.from.id, untilDate);
              } catch (error) {
                const sentMsg = await premiumEmojis.replyWithCustomEmoji(ctx, `{alert} ${userLabel}: Получил ${warnLimit}-е предупреждение и должен быть забанен, но бот не может выполнить бан.`, { '{alert}': 'warning_alert' }, { parse_mode: 'HTML' });
                scheduleDeleteForContext(ctx, sentMsg?.message_id, 5000);
                return;
              }
              database.addPunishment(ctx.chat.id, ctx.from.id, 'ban', `Автобан после ${warnLimit} предупреждений. Последнее: ${reason}`, untilDate);
              database.addActivePunishment(ctx.chat.id, ctx.from.id, 'ban', `Автобан после ${warnLimit} предупреждений. Последнее: ${reason}`, untilDate);
              schedulePunishmentExpiry({
                chatId: ctx.chat.id,
                userId: ctx.from.id,
                action: 'ban',
                untilAt: untilDate,
              });
              const sentMsg1 = await premiumEmojis.replyWithCustomEmoji(ctx, `{alert} ${userLabel}: Получил ${warnLimit}-е предупреждение и забанен на ${blockDuration}ч.`, { '{alert}': 'warning_alert' }, { parse_mode: 'HTML' });
              scheduleDeleteForContext(ctx, sentMsg1?.message_id, 5000);
            } else {
              const sentMsg2 = await premiumEmojis.replyWithCustomEmoji(ctx, `{alert} ${userLabel}: Предупреждение ${warningCount}/${warnLimit}. Причина: ${reason}`, { '{alert}': 'warning_alert' }, { parse_mode: 'HTML' });
              scheduleDeleteForContext(ctx, sentMsg2?.message_id, 5000);
            }
        } else if (settings.punishmentMode === 'mute') {
          await applyAutomaticMute(ctx, ctx.from.id, 24, reason);
        } else if (settings.punishmentMode === 'kick') {
          try {
            await ctx.telegram.unbanChatMember(ctx.chat.id, ctx.from.id);
            await ctx.telegram.kickChatMember(ctx.chat.id, ctx.from.id);
          } catch (error) {
            const userLabel = getMentionText(ctx.from || { id: ctx.from.id });
            const sentMsg = await premiumEmojis.replyWithCustomEmoji(ctx, `{alert} ${userLabel}: Должен быть кикнут, но бот не может выполнить действие.`, { '{alert}': 'warning_alert' }, { parse_mode: 'HTML' });
            scheduleDeleteForContext(ctx, sentMsg?.message_id, 5000);
            return;
          }
          database.addPunishment(ctx.chat.id, ctx.from.id, 'kick', reason, null);
          const userLabel = getMentionText(ctx.from || { id: ctx.from.id });
          const sentMsg = await premiumEmojis.replyWithCustomEmoji(ctx, `{alert} ${userLabel}: Кикнут. Причина: ${reason}`, { '{alert}': 'warning_alert' }, { parse_mode: 'HTML' });
          scheduleDeleteForContext(ctx, sentMsg?.message_id, 5000);
        } else if (settings.punishmentMode === 'ban') {
          const untilDate = Math.floor(Date.now() / 1000) + 86400 * 365; // Ban for a year by default
          try {
            await ctx.telegram.banChatMember(ctx.chat.id, ctx.from.id, untilDate);
          } catch (error) {
            const userLabel = getMentionText(ctx.from || { id: ctx.from.id });
            const sentMsg = await premiumEmojis.replyWithCustomEmoji(ctx, `{alert} ${userLabel}: Должен быть забанен, но бот не может выполнить действие.`, { '{alert}': 'warning_alert' }, { parse_mode: 'HTML' });
            scheduleDeleteForContext(ctx, sentMsg?.message_id, 5000);
            return;
          }
          database.addPunishment(ctx.chat.id, ctx.from.id, 'ban', reason, untilDate);
          database.addActivePunishment(ctx.chat.id, ctx.from.id, 'ban', reason, untilDate);
          schedulePunishmentExpiry({
            chatId: ctx.chat.id,
            userId: ctx.from.id,
            action: 'ban',
            untilAt: untilDate,
          });
          const userLabel = getMentionText(ctx.from || { id: ctx.from.id });
          const sentMsg = await premiumEmojis.replyWithCustomEmoji(ctx, `{alert} ${userLabel}: Забанен. Причина: ${reason}`, { '{alert}': 'warning_alert' }, { parse_mode: 'HTML' });
          scheduleDeleteForContext(ctx, sentMsg?.message_id, 5000);
        }
        return;
      }
    }

    if (isGroupChat(ctx) && isMediaMessage(ctx)) {
      const service = activeModerationService || defaultModerationService;
      if (service.isMediaAiEnabled(ctx.chat.id)) {
        if (!config.aiApiKey) {
          console.warn('Media AI enabled but no AI API key configured for group', ctx.chat.id);
        } else {
          const isAdult = await analyzeMediaWithAi(ctx, message);
          if (isAdult) {
            try {
              await deleteMessageSafely(ctx, message.message_id);
            } catch (err) {
              // ignore
            }

            try {
              await replyWithAutoDelete(
                ctx,
                `🚫 Медиа-контент запрещён. Медиа удалено.`,
                {},
                2000,
              );
            } catch (err) {
              console.warn('Failed to notify about blocked adult media:', err?.message || err);
            }
            return;
          }
        }
      }
    }

    if (isGroupChat(ctx) && isAdminReportText(text)) {
      const reply = message.reply_to_message;
      if (!reply || !reply.from) {
        await ctx.reply('Для жалобы @admin ответьте на сообщение нарушителя.');
        return;
      }

      if (await canManageGroupSettings(ctx, ctx.chat.id)) {
        await ctx.reply('Администраторы и модераторы не могут использовать @admin.');
        return;
      }

      const reportId = createAdminReportId();
      const report = {
        id: reportId,
        chatId: ctx.chat.id,
        groupTitle: ctx.chat.title || String(ctx.chat.id),
        reporter: {
          id: ctx.from.id,
          first_name: ctx.from.first_name,
          username: ctx.from.username,
        },
        target: {
          user: {
            id: reply.from.id,
            first_name: reply.from.first_name,
            username: reply.from.username,
          },
          messageId: reply.message_id,
        },
      };
      // store report and message IDs for notifications
      report.notifications = [];
      adminReports.set(reportId, report);

      try {
        const mode = moderationService.getAdminNotifyMode(ctx.chat.id);
        // if mode is 'staff' we avoid posting the report in the origin chat
        if (mode !== 'staff') {
          const originMsg = await ctx.reply(formatAdminReportText(report), { reply_markup: buildAdminReportKeyboard(report) });
          if (originMsg && originMsg.message_id) {
            report.notifications.push({ chatId: ctx.chat.id, messageId: originMsg.message_id, origin: true });
          }
        }
      } catch (error) {
        console.error('Failed to post admin report in origin chat:', error?.message || error);
      }

      const moderationService = activeModerationService || defaultModerationService;
      const shouldNotifyAdmins = moderationService.getAdminNotifyAdmins(ctx.chat.id);
      if (shouldNotifyAdmins && Number.isFinite(ADMIN_NOTIFICATION_GROUP_ID) && ADMIN_NOTIFICATION_GROUP_ID !== 0 && ADMIN_NOTIFICATION_GROUP_ID !== ctx.chat.id) {
        try {
          const adminMsg = await ctx.telegram.sendMessage(ADMIN_NOTIFICATION_GROUP_ID, formatAdminReportText(report), { reply_markup: buildAdminReportKeyboard(report) });
          if (adminMsg && adminMsg.message_id) {
            report.notifications.push({ chatId: ADMIN_NOTIFICATION_GROUP_ID, messageId: adminMsg.message_id, origin: false });
          }
        } catch (error) {
          console.error('Failed to send admin notification to admin group:', error?.message || error);
        }
      }
      return;
    }

    if (text.startsWith('!')) {
      if (await handleRussianCommand(ctx, text)) {
        return;
      }

      if (isPrivateChat(ctx) && !isKnownCommandText(text)) {
        await handlePrivateAIMessages(ctx, text);
        return;
      }
    }

    if (text.startsWith('/')) {
      if (isPrivateChat(ctx) && !isKnownCommandText(text)) {
        await handlePrivateAIMessages(ctx, text);
        return;
      }
      return;
    }

    if (isPrivateChat(ctx) && !isKnownCommandText(text)) {
      await handlePrivateAIMessages(ctx, text);
      return;
    }

    if (lowerText.startsWith('+антиспам') || lowerText.startsWith('+antispam')) {
      ensureGroup(ctx);
      if (!isBotAdmin(ctx)) {
        ctx.reply('Эта команда доступна только администраторам.');
        return;
      }
      moderationService.enableSpamProtection(ctx.chat.id);
      ctx.reply('✅ Антиспам включён.');
      return;
    }

    if (lowerText.startsWith('-антиспам') || lowerText.startsWith('-antispam')) {
      ensureGroup(ctx);
      if (!isBotAdmin(ctx)) {
        ctx.reply('Эта команда доступна только администраторам.');
        return;
      }
      moderationService.disableSpamProtection(ctx.chat.id);
      ctx.reply('✅ Антиспам выключен.');
      return;
    }

    if (lowerText.startsWith('+антифлуд') || lowerText.startsWith('+antiflood')) {
      ensureGroup(ctx);
      if (!isBotAdmin(ctx)) {
        ctx.reply('Эта команда доступна только администраторам.');
        return;
      }
      moderationService.enableFloodProtection(ctx.chat.id);
      ctx.reply('✅ Антифлуд включён.');
      return;
    }

    if (lowerText.startsWith('-антифлуд') || lowerText.startsWith('-antiflood')) {
      ensureGroup(ctx);
      if (!isBotAdmin(ctx)) {
        ctx.reply('Эта команда доступна только администраторам.');
        return;
      }
      moderationService.disableFloodProtection(ctx.chat.id);
      ctx.reply('✅ Антифлуд выключен.');
      return;
    }

    const addAllowedLinkMatch = text.match(/^\+(?:links|ссылки)\s+(.+)$/i);
    if (addAllowedLinkMatch) {
      ensureGroup(ctx);
      if (!isBotAdmin(ctx)) {
        ctx.reply('Эта команда доступна только администраторам.');
        return;
      }
      const linkValue = addAllowedLinkMatch[1].trim();
      if (!linkValue) {
        ctx.reply('Использование: +links <url> — добавить разрешённую ссылку или домен.');
        return;
      }
      if (moderationService.addAllowedLink(ctx.chat.id, linkValue)) {
        ctx.reply(`✅ Разрешённая ссылка добавлена: ${linkValue}`);
      } else {
        ctx.reply('Эта ссылка уже добавлена или формат некорректен.');
      }
      return;
    }

    const removeAllowedLinkMatch = text.match(/^\-(?:links|ссылки)(?:\s+(.+))?$/i);
    if (removeAllowedLinkMatch && removeAllowedLinkMatch[1] !== undefined) {
      ensureGroup(ctx);
      if (!isBotAdmin(ctx)) {
        ctx.reply('Эта команда доступна только администраторам.');
        return;
      }
      const argValue = removeAllowedLinkMatch[1].trim();
      if (!argValue) {
        moderationService.disableLinkProtection(ctx.chat.id);
        ctx.reply('✅ Антиссылки выключены.');
        return;
      }

      if (argValue.toLowerCase() === 'all') {
        if (moderationService.clearAllowedLinks(ctx.chat.id)) {
          ctx.reply('✅ Все разрешённые ссылки и домены удалены.');
        } else {
          ctx.reply('Список разрешённых ссылок уже пуст.');
        }
        return;
      }

      if (moderationService.removeAllowedLink(ctx.chat.id, argValue)) {
        ctx.reply(`✅ Удалена разрешённая ссылка/домен: ${argValue}`);
      } else {
        ctx.reply('Эта ссылка или домен не найдены в списке разрешённых.');
      }
      return;
    }

    if (lowerText === '+ссылки' || lowerText === '+links') {
      ensureGroup(ctx);
      if (!isBotAdmin(ctx)) {
        ctx.reply('Эта команда доступна только администраторам.');
        return;
      }
      moderationService.enableLinkProtection(ctx.chat.id);
      ctx.reply('✅ Антиссылки включены.');
      return;
    }

    if (lowerText === '-ссылки' || lowerText === '-links') {
      ensureGroup(ctx);
      if (!isBotAdmin(ctx)) {
        ctx.reply('Эта команда доступна только администраторам.');
        return;
      }
      moderationService.disableLinkProtection(ctx.chat.id);
      ctx.reply('✅ Антиссылки выключены.');
      return;
    }

    const descriptionMatch = text.match(/^(\+описание|\+description)(?:\s+(.+))?$/i);
    if (descriptionMatch) {
      const description = (descriptionMatch[2] || '').trim();
      if (!description) {
        ctx.reply('Использование: +описание текст или +description text');
        return;
      }
      database.setUserDescription(ctx.chat.id, ctx.from.id, description);
      ctx.reply('✅ Описание добавлено в вашу анкету.');
      return;
    }

    if (lowerText.startsWith('+rules ') || lowerText.startsWith('+правила ')) {
      if (!isBotAdmin(ctx)) {
        ctx.reply('Эта команда доступна только администраторам.');
        return;
      }
      ensureGroup(ctx);
      const newRules = lowerText.startsWith('+rules') ? text.slice(7) : text.slice(10);
      if (!newRules.trim()) {
        ctx.reply('Использование: +rules новые правила или +правила новые правила');
        return;
      }
      moderationService.setRules(ctx.chat.id, newRules.trim());
      ctx.reply('✅ Правила чата обновлены.');
      return;
    }

    if (lowerText.startsWith('+greeting ') || lowerText.startsWith('+приветствие ')) {
      if (!isBotAdmin(ctx)) {
        ctx.reply('Эта команда доступна только администраторам.');
        return;
      }
      ensureGroup(ctx);
      const newGreeting = lowerText.startsWith('+greeting') ? text.slice(10) : text.slice(13);
      if (!newGreeting.trim()) {
        ctx.reply('Использование: +greeting новое приветствие или +приветствие новое приветствие');
        return;
      }
      moderationService.setGreeting(ctx.chat.id, newGreeting.trim());
      ctx.reply('✅ Приветствие чата обновлено.');
      return;
    }

    if (isGroupChat(ctx) && moderationService.isFloodProtectionEnabled(ctx.chat.id) && hasRepeatedCharacterFlood(text)) {
      queueBulkModerationSummary(ctx, ctx.from.id, 'Антифлуд');
      await deleteMessageSafely(ctx, ctx.message.message_id);
      await applyAutomaticMute(ctx, ctx.from.id, 1, 'Антифлуд');
      return;
    }

    if (isGroupChat(ctx) && moderationService.isSpamProtectionEnabled(ctx.chat.id)) {
      const shouldPunish = trackSpamActivity(ctx);
      if (shouldPunish) {
        const recentMessages = spamActivity.get(ctx.chat.id)?.get(ctx.from.id)?.messages || [];
        if (recentMessages.length) {
          queueBulkModerationSummary(ctx, ctx.from.id, 'Спам');
          await Promise.all(recentMessages.map((item) => deleteMessageSafely(ctx, item.messageId)));
        }
        await applyAutomaticMute(ctx, ctx.from.id, 24, 'Спам');
        return;
      }
    }

    // Check for banned words
    const forbiddenWord = isGroupChat(ctx) && moderationService.findBanWord(ctx.chat.id, text);
    if (forbiddenWord) {
      queueBulkModerationSummary(ctx, ctx.from.id, `Запрещённое слово: ${forbiddenWord}`);
      await applyBanwordPunishment(ctx, ctx.from.id, forbiddenWord);
      return;
    }

    if (isGroupChat(ctx) && moderationService.isLinkProtectionEnabled(ctx.chat.id) && isLinkMessage(text, (link) => moderationService.isAllowedLink(ctx.chat.id, link))) {
      console.log('anti-link triggered', {
        chatId: ctx.chat.id,
        userId: ctx.from?.id,
        text,
        links: getLinkCandidates(text),
        allowed: getLinkCandidates(text).map((link) => moderationService.isAllowedLink(ctx.chat.id, link)),
      });
      queueBulkModerationSummary(ctx, ctx.from.id, 'Ссылка');
      await deleteMessageSafely(ctx, ctx.message.message_id);
      await applyAutomaticMute(ctx, ctx.from.id, 24 * 7, 'Ссылка');
      return;
    }

    const rulesEnabled = isGroupChat(ctx) && moderationService.isRulesEnabled(ctx.chat.id);
    if (rulesEnabled) {
      const response = moderationService.findFilterResponse(ctx.chat.id, text);
      if (response) {
        ctx.reply(response);
        return;
      }
    }

    if (isPrivateChat(ctx)) {
      await handlePrivateAIMessages(ctx, text);
      return;
    }
  }

  bot.command(['promote', 'повышение'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:promote|повышение)(?:@[\w_]+)?\s*/i, '');
    await adjustBotAdminLevelCommand(ctx, args, 'promote');
  });

  bot.command(['demote', 'разжалование'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:demote|разжалование)(?:@[\w_]+)?\s*/i, '');
    await adjustBotAdminLevelCommand(ctx, args, 'demote');
  });

  bot.on(['text', 'photo', 'video', 'document', 'animation', 'audio', 'voice', 'sticker', 'video_note'], async (ctx) => {
    if (ctx.chat && getPendingSettingsAction(ctx)) {
      const handled = await processPendingSettingsAction(ctx);
      if (handled) {
        return;
      }
    }

    if (ctx.chat && getPendingMenuAction(ctx)) {
      const handled = await processPendingMenuAction(ctx);
      if (handled) {
        return;
      }
    }

    if (isAllowedAnonymousChannel(ctx)) {
      await sendMenuReplyForChannelPost(ctx);
      return;
    }

    if (isChannelPostInGroup(ctx)) {
      await sendMenuReplyForChannelPost(ctx);
      return;
    }

    await handleIncomingMessage(ctx);
  });

  return { bot, config, userService, moderationService, database };
}

function startBot(botState = null) {
  const state = botState || createBot();
  const { bot, config } = state;
  if (!config.botToken) {
    console.log('BOT_TOKEN is not configured.');
    return;
  }
  bot.launch().then(() => {
    console.log('Bot started');
  }).catch((error) => {
    console.error(error);
  });
}

module.exports = {
  createBot,
  buildCaptchaChallenge,
  generateCaptchaPollOptions,
  shouldStartCaptchaForChat,
  getCaptchaEmojiSet,
  parsePunishmentDetails,
  buildPunishmentNotification,
  buildModerationAlertMessage,
  buildBulkModerationSummaryMessage,
  buildFunReply,
  parsePageNumber,
  buildPunishmentListMessage,
  buildBotAdminListMessage,
  buildSettingsMainKeyboard,
  buildSettingsChatKeyboard,
  buildMenuKeyboard,
  buildMembersManagementKeyboard,
  canSelfClearPunishmentHistory,
  buildSettingsWarnsKeyboard,
  buildSettingsCommandRightsKeyboard,
  buildSettingsFirstMessageKeyboard,
  buildSettingsRulesMenuText,
  buildSettingsAnonymousMenuText,
  buildSettingsAnonymousKeyboard,
  isAnonymousSenderMessage,
  isChannelPostInGroupMessage,
  shouldFailClosedForMedia,
  parseSettingsAction,
  detectForbiddenWord,
  isLinkMessage,
  isAllowedLinkUrl,
  isGroupOwnerMember,
  isGroupMemberWithProfileChangePermission,
  isGroupMemberWithManageRights,
  getGroupDisplayName,
  detectForwardedMessageCategory,
  startBot,
  cleanupAgreementMessages,
  handleAgreementDecision,
};

2
