const path = require('node:path');
const { Telegraf } = require('telegraf');
const sharp = require('sharp');
const { loadConfig, getMiniAppPort, detectPublicMiniAppUrl } = require('./config');
const UserService = require('./services/user_service');
const ModerationService = require('./services/moderation_service');
const Database = require('./services/database');
const { getFunnyDescription } = require('./services/moderation_service');
const { getMentionText, resolveUsernameTarget } = require('./services/username_service');

const defaultModerationService = new ModerationService();
let activeDatabase = null;
let activeModerationService = null;
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

  return !hasRegularUser && (isSenderChatChannel || isForwardedFromChannel);
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

function isGroupMemberWithProfileChangePermission(member) {
  if (!member || typeof member !== 'object') {
    return false;
  }

  const status = String(member.status || '').toLowerCase();
  if (status === 'creator') {
    return true;
  }

  return status === 'administrator' && Boolean(member.can_change_info);
}

function isGroupMemberWithManageRights(member) {
  if (!member || typeof member !== 'object') {
    return false;
  }

  const status = String(member.status || '').toLowerCase();
  if (status === 'creator') {
    return true;
  }

  return status === 'administrator' && Boolean(member.can_delete_messages || member.can_restrict_members || member.can_invite_users || member.can_manage_topics || member.can_pin_messages || member.can_manage_chat || member.can_manage_video_chats || member.can_promote_members || member.can_manage_events || member.can_change_info);
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
    if (isGroupMemberWithProfileChangePermission(member) || isGroupMemberWithManageRights(member)) {
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
    return isGroupMemberWithProfileChangePermission(member) || isGroupMemberWithManageRights(member);
  } catch (error) {
    return false;
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
    await ctx.reply('У вас нет групп, где вы можете менять настройки бота.');
    return;
  }

  const keyboard = {
    inline_keyboard: [
      ...managedGroups.map((group) => [{ text: group.title, callback_data: `settings:select:${group.chatId}` }]),
      [{ text: 'Закрыть', callback_data: 'settings:close' }],
    ],
  };

  if (ctx.callbackQuery) {
    await ctx.editMessageText('Выберите группу для настроек:', { reply_markup: keyboard });
  } else {
    await ctx.reply('Выберите группу для настроек:', { reply_markup: keyboard });
  }
}

function buildSettingsMainKeyboard(chatId) {
  return [
    [
      { text: 'Капча', callback_data: `settings:section:captcha:${chatId}` },
      { text: 'Ссылки', callback_data: `settings:section:links:${chatId}` },
    ],
    [
      { text: 'Анти(СФС)', callback_data: `settings:section:anti:${chatId}` },
      { text: 'Правила', callback_data: `settings:section:rules:${chatId}` },
    ],
    [
      { text: 'Первый Коммент', callback_data: `settings:open_menu:${chatId}` },
    ],
    [
      { text: '@admin', callback_data: `settings:section:admin:${chatId}` },
      { text: '🚫 Скрытые пользователи', callback_data: `settings:section:anonymous:${chatId}` },
    ],
  ];
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
      [{ text: 'Назад', callback_data: `settings:main:${chatId}` }],
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
  return {
    inline_keyboard: [
      [{ text: 'Добавить слово', callback_data: `settings:banword_add:${chatId}` }],
      [{ text: 'Удалить слово', callback_data: `settings:banword_remove:${chatId}` }],
      [{ text: 'Список запрещённых слов', callback_data: `settings:banword_list:${chatId}` }],
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
      '/warnings, !варны [@юз] - показать варны пользователя',
      '/unwarn, !снять предупреждение @юз - снять предупреждения',
      '/mute, !мут @юз <время> <причина> - ограничить сообщения',
      '/unmute, !размут - снять ограничение',
      '/ban, !бан <время> <причина> - заблокировать пользователя',
      '/unban, !разбан - разблокировать пользователя',
      '/banlist, !баны [страница] - список активных банов',
      '/mutelist, !муты [страница] - список активных мутов',
      '/admins, !админы - список администраторов бота',
      '/addadmin @юз, !добавить админа @юз - назначить админа бота',
      '/removeadmin @юз, !снять админа @юз - снять вспомогательного администратора бота',
      '/promote @юз [уровень], !повышение @юз [уровень] - повысить администратора (если уровень не указан, повышает на 1)',
      '/demote @юз [уровень], !разжалование @юз [уровень] - понизить администратора (если уровень не указан, понижает на 1)',
    ].join('\n'),
    [
      '📋 Система уровней администраторов',
      '',
      'Уровни (1 = наивысший):',
      '1 — Главный админ (владелец группы). Только владелец получает этот уровень автоматически.',
      '2 — Ведущий админ. Почти все команды модерации (кроме антиспам/антиссылки/антифлуд). Может добавлять и снимать админов ниже себя.',
      '3 — Старший админ. Доступ к ban и управлению пользователями ниже по уровню (может наказывать, но не снимать права).',
      '4 — Средний админ. Доступ к warn и mute и их снятию.',
      '5 — Младший админ. Доступ только к выдаче предупреждений и просмотру варн-листа.',
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
    '🚫 Скрытые пользователи',
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

  await ctx.editMessageText(buildSettingsAnonymousMenuText(), { reply_markup: buildSettingsAnonymousKeyboard(chatId) });
}

async function showSettingsAnonymousExceptionsMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  await ctx.editMessageText(buildSettingsAnonymousExceptionsText(chatId), { reply_markup: buildSettingsAnonymousExceptionsKeyboard(chatId) });
}

async function showSettingsAdminMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  await ctx.editMessageText(buildSettingsAdminMenuText(), { reply_markup: buildSettingsAdminKeyboard(chatId) });
}

async function showSettingsMainMenu(ctx, chatId) {
  if (!(await canManageGroupSettings(ctx, chatId))) {
    await ctx.reply('У вас нет прав менять настройки этой группы.');
    return;
  }

  const title = getGroupDisplayName(chatId, String(chatId));
  const text = `⚙️ Настройки бота для группы:\n${title}`;
  const replyMarkup = { inline_keyboard: buildSettingsMainKeyboard(chatId) };
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { reply_markup: replyMarkup });
  } else {
    await ctx.reply(text, { reply_markup: replyMarkup });
  }
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
      [{ text: 'Назад', callback_data: `settings:main:${chatId}` }],
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
  const words = service.getBanWords(chatId);
  const text = [
    '🚫 Запрещённые слова',
    '',
    words.length ? `• ${words.join('\n• ')}` : 'Список пуст.',
  ].join('\n');

  await ctx.editMessageText(text, { reply_markup: buildSettingsBanwordsKeyboard(chatId) });
}

function parseSettingsAction(action) {
  const parts = String(action || '').split(':').filter(Boolean);
  const isPrefixed = parts[0] === 'settings' && parts.length > 1;
  const normalizedParts = isPrefixed ? parts.slice(1) : parts;
  const actionType = normalizedParts[0] || '';
  const target = actionType === 'select' ? 'select' : actionType;

  let parsedChatId = 0;
  let value = '';
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
    value = String(nonNumericRemaining[nonNumericRemaining.length - 1] || '');
  } else if (remainingArgs.length > 0) {
    value = String(remainingArgs[remainingArgs.length - 1] || '');
  }

  return {
    type: actionType,
    target,
    chatId: parsedChatId,
    section: actionType === 'section' ? normalizedParts[1] || '' : '',
    value,
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
    return 'Отправьте запрещённое слово для добавления.';
  }
  if (action === 'settings_banword_remove') {
    return 'Отправьте запрещённое слово для удаления.';
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
    5: 'Младший',
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
  const punishmentTimers = new Map();
  const spamActivity = new Map();
  const messageHistory = new Map();
  const captchaStates = new Map();
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
    const shuffledOptions = [...challenge.options, challenge.correctOption].sort(() => Math.random() - 0.5);
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

  function scheduleDeleteMessage(telegram, chatId, messageId, delay = 5000) {
    if (!chatId || !messageId) {
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

  async function completeCaptcha(ctx, pollId, passed) {
    const state = captchaStates.get(pollId);
    if (!state) {
      return;
    }

    captchaStates.delete(pollId);

    if (passed) {
      await ctx.telegram.restrictChatMember(state.chatId, state.userId, buildMutePermissions(true));
      const sentGroupMessage = await ctx.telegram.sendMessage(state.chatId, `Пользователь ${state.displayName} прошёл капчу и получил доступ к чату.`);
      scheduleDeleteMessage(ctx.telegram, state.chatId, sentGroupMessage?.message_id);
      scheduleDeleteMessage(ctx.telegram, state.chatId, state.pollMessageId);
      scheduleDeleteMessage(ctx.telegram, state.chatId, state.instructionMessageId);
      return;
    }

    try {
      await ctx.telegram.banChatMember(state.chatId, state.userId);
      await ctx.telegram.unbanChatMember(state.chatId, state.userId, { only_if_banned: true });
    } catch (error) {
      // ignore if the member cannot be removed or unbanned
    }
    await ctx.telegram.sendMessage(state.userId, 'Капча не пройдена. Вы исключены из группы.');
    await ctx.telegram.sendMessage(state.chatId, `Пользователь ${state.displayName} не прошёл капчу и исключён из группы.`);
    setTimeout(async () => {
      try {
        await ctx.telegram.deleteMessage(state.chatId, state.pollMessageId);
      } catch (deleteError) {
        // ignore deletion errors
      }
    }, 5000);
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

      try {
        await bot.telegram.sendMessage(userId, `Ваше автоматическое ограничение (${action}) в чате было снято.`);
      } catch (notifyError) {
        // ignore private message failures due to privacy settings
      }
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

  function isMediaMessage(ctx) {
    const message = ctx.message || {};
    return Boolean(message.photo || message.video || message.document || message.animation || message.audio || message.voice || message.sticker || message.video_note);
  }

  function isKnownCommandText(text) {
    const slashCommand = /^\/(start|help|id|about|whoami|stats|rules|allowed|links|hug|kiss|slap|poke|coin|dice|fate|compliment|insult|top|admins|banlist|mutelist|setrules|warn|warnings|unwarn|mute|unmute|ban|unban|setgreeting|addadmin|removeadmin|promote|demote|ai)(\s|$)/i;
    const bangCommand = /^!(начало|помощь|айди|информация|кто\s*я|статистика|правила|обнять|поцеловать|шлёпнуть|тыкнуть|монетка|кубик|вопрос|комплимент|инсульт)(\s|$)/i;
    const plusMinusCommand = /^(\+антиспам|\+antispam|\+антифлуд|\+antiflood|\-антиспам|\-antispam|\-антифлуд|\-antiflood|\+ссылки|\+links|\-ссылки|\-links|\+описание|\+description|\+rules|\+правила|\+greeting|\+приветствие)(\s|$)/i;
    return slashCommand.test(text) || bangCommand.test(text) || plusMinusCommand.test(text);
  }

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
      await ctx.reply(buildModerationAlertMessage(userLabel, durationHours, reason));
    }

    try {
      await ctx.telegram.sendMessage(userId, buildPunishmentNotification('mute', ctx.chat.title || String(ctx.chat.id), reason, durationHours));
    } catch (error) {
      // ignore private message failures due to privacy settings
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
    const status = isNew ? 'Рад знакомству' : 'С возвращением';
    ctx.reply(`${status}, ${ctx.from.first_name || 'пользователь'}!\n\nИспользуйте /help или !помощь, чтобы увидеть команды.`);
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
      ],
    };
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
    return [
      { cmd: 'staff', label: '/staff' },
      { cmd: 'rules', label: '/rules' },
      { cmd: 'me', label: '/me' },
      { cmd: 'translate', label: '/translate' },
      { cmd: 'link', label: '/link' },
      { cmd: 'help', label: '/help' },
      { cmd: 'whoami', label: '/whoami' },
      { cmd: 'coin', label: '/coin' },
      { cmd: 'dice', label: '/dice' },
      { cmd: 'start', label: '/start' },
      { cmd: 'id', label: '/id' },
      { cmd: 'about', label: '/about' },
      { cmd: 'stats', label: '/stats' },
      { cmd: 'top', label: '/top' },
      { cmd: 'warn', label: '/warn' },
      { cmd: 'warnings', label: '/warnings' },
      { cmd: 'unwarn', label: '/unwarn' },
      { cmd: 'mute', label: '/mute' },
      { cmd: 'unmute', label: '/unmute' },
      { cmd: 'ban', label: '/ban' },
      { cmd: 'unban', label: '/unban' },
      { cmd: 'banlist', label: '/banlist' },
      { cmd: 'mutelist', label: '/mutelist' },
      { cmd: 'admins', label: '/admins' },
      { cmd: 'addadmin', label: '/addadmin' },
      { cmd: 'removeadmin', label: '/removeadmin' },
      { cmd: 'promote', label: '/promote' },
      { cmd: 'demote', label: '/demote' },
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

  function buildCommandRightsPageText(chatId, pageIndex = 0) {
    const service = activeModerationService || defaultModerationService;
    const commands = getCommandsList();
    const rights = service.getAllCommandRights(chatId);
    const totalPages = Math.max(1, Math.ceil(commands.length / COMMANDS_PER_PAGE));
    const page = Math.max(0, Math.min(pageIndex, totalPages - 1));

    const header = [
      '🔐 ПРАВА НА КОМАНДЫ',
      '',
      'В этом меню вы можете настроить права следующих команд.',
      '',
      '❌ = Никто | 👥 = Все | 👨‍💼 = Админы',
      '',
    ];

    const start = page * COMMANDS_PER_PAGE;
    const pageCommands = commands.slice(start, start + COMMANDS_PER_PAGE);

    pageCommands.forEach(({ cmd, label }) => {
      const level = rights[cmd] || 'all';
      header.push(`${getPermissionEmoji(level)} ${label} — ${getPermissionLabel(level)}`);
    });

    header.push('');
    header.push(`Страница ${page + 1}/${totalPages}`);
    return header.join('\n');
  }

  function buildCommandRightsPageKeyboard(chatId, pageIndex = 0) {
    const commands = getCommandsList();
    const service = activeModerationService || defaultModerationService;
    const rights = service.getAllCommandRights(chatId);
    const totalPages = Math.max(1, Math.ceil(commands.length / COMMANDS_PER_PAGE));
    const page = Math.max(0, Math.min(pageIndex, totalPages - 1));

    const start = page * COMMANDS_PER_PAGE;
    const pageCommands = commands.slice(start, start + COMMANDS_PER_PAGE);

    const rows = [];
    // For each command show: [label] [none] [admin] [all]
    pageCommands.forEach((item, idx) => {
      const index = start + idx;
      const level = rights[item.cmd] || 'all';
      const noneText = level === 'none' ? `${getPermissionEmoji('none')} Никто ✅` : `${getPermissionEmoji('none')} Никто`;
      const adminText = level === 'admin' ? `${getPermissionEmoji('admin')} Админы ✅` : `${getPermissionEmoji('admin')} Админы`;
      const allText = level === 'all' ? `${getPermissionEmoji('all')} Все ✅` : `${getPermissionEmoji('all')} Все`;

      const noneButton = { text: noneText, callback_data: `menu:command_rights:toggle:${index}:none` };
      const adminButton = { text: adminText, callback_data: `menu:command_rights:toggle:${index}:admin` };
      const allButton = { text: allText, callback_data: `menu:command_rights:toggle:${index}:all` };
      const labelBtn = { text: item.label, callback_data: `menu:command_rights:select:${index}` };

      const row = [labelBtn, noneButton, adminButton, allButton];
      rows.push(row);
    });

    // Navigation buttons
    const nav = [];
    if (page > 0) nav.push({ text: '⬅️ Назад', callback_data: `menu:command_rights:nav:${page - 1}` });
    if (page < totalPages - 1) nav.push({ text: 'Вперёд ➡️', callback_data: `menu:command_rights:nav:${page + 1}` });

    if (nav.length) rows.push(nav);
    rows.push([{ text: 'Назад', callback_data: 'menu:overview' }]);

    return { inline_keyboard: rows };
  }

  async function showMenuCommandRightsMenu(ctx, chatId, pageIndex = 0) {
    if (!(await canManageGroupSettings(ctx, chatId))) {
      await ctx.reply('У вас нет прав менять настройки этой группы.');
      return;
    }

    const text = buildCommandRightsPageText(chatId, pageIndex);
    const keyboard = buildCommandRightsPageKeyboard(chatId, pageIndex);
    await ctx.editMessageText(text, { reply_markup: keyboard });
  }

  function getMediaPayloadFromMessage(ctx) {
    const message = ctx.message || {};
    if (message.photo && Array.isArray(message.photo) && message.photo.length) {
      return { type: 'photo', fileId: message.photo[message.photo.length - 1].file_id };
    }
    if (message.video && message.video.file_id) {
      return { type: 'video', fileId: message.video.file_id };
    }
    if (message.animation && message.animation.file_id) {
      return { type: 'animation', fileId: message.animation.file_id };
    }
    if (message.document && message.document.file_id) {
      return { type: 'document', fileId: message.document.file_id };
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
      return { type: 'sticker', fileId: message.sticker.file_id };
    }
    return null;
  }

  function buildTextPayloadFromMessage(ctx) {
    const message = ctx.message || {};
    const text = typeof message.text === 'string' ? message.text : '';
    const entities = Array.isArray(message.entities)
      ? message.entities.filter((entity) => entity && typeof entity === 'object').map((entity) => ({ ...entity }))
      : [];
    return { text, entities };
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
    const replyOptions = { reply_to_message_id: ctx.message.message_id };
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
          reply_to_message_id: replyOptions.reply_to_message_id,
        };
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

    if (pending.action === 'settings_rules_set' && ctx.message.text) {
      moderationService.setRules(groupId, buildTextPayloadFromMessage(ctx));
      await ctx.reply('✅ Правила группы обновлены.');
      clearPendingSettingsAction(ctx);
      return true;
    }

    if (pending.action === 'settings_banword_add' && ctx.message.text) {
      const value = String(ctx.message.text).trim().toLowerCase();
      if (!value) {
        await ctx.reply('⚠️ Пустое слово не добавлено.');
        return true;
      }
      if (moderationService.addBanWord(groupId, value)) {
        await ctx.reply(`✅ Запрещённое слово добавлено: ${value}`);
      } else {
        await ctx.reply('⚠️ Это слово уже есть в списке.');
      }
      clearPendingSettingsAction(ctx);
      return true;
    }

    if (pending.action === 'settings_banword_remove' && ctx.message.text) {
      const value = String(ctx.message.text).trim().toLowerCase();
      if (!value) {
        await ctx.reply('⚠️ Пустое слово не удалено.');
        return true;
      }
      if (moderationService.removeBanWord(groupId, value)) {
        await ctx.reply(`✅ Запрещённое слово удалено: ${value}`);
      } else {
        await ctx.reply('⚠️ Такого слова нет в списке.');
      }
      clearPendingSettingsAction(ctx);
      return true;
    }

    if (pending.action === 'settings_message_text' && ctx.message.text) {
      moderationService.setMenuText(groupId, buildTextPayloadFromMessage(ctx));
      await ctx.reply('✅ Текст первого сообщения обновлён.');
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

      // remove stored report
      adminReports.delete(reportId);
      clearPendingSettingsAction(ctx);
      // optionally confirm in the admin chat
      try {
        await ctx.reply('✅ Отчёт добавлен в уведомление.');
      } catch (err) {
        // ignore
      }
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

    return false;
  }

  async function menuCommand(ctx) {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const chatId = Number(ctx.chat?.id || 0);
    if (!chatId || !(await canManageGroupSettings(ctx, chatId))) {
      await ctx.reply('У вас нет прав менять настройки этой группы.');
      return;
    }

    await ctx.reply(formatMenuOverview(chatId), { reply_markup: getMenuKeyboard(chatId) });
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
        '/warnings, !варны [@юз] - показать варны пользователя',
        '/unwarn, !снять предупреждение @юз - снять предупреждения',
        '/mute, !мут @юз <время> <причина> - ограничить сообщения',
        '/unmute, !размут - снять ограничение',
        '/ban, !бан <время> <причина> - заблокировать пользователя',
        '/unban, !разбан - разблокировать пользователя',
        '/banlist, !баны [страница] - список активных банов',
        '/mutelist, !муты [страница] - список активных мутов',
          '/admins, !админы - список администраторов бота',
        '/addadmin @юз, !добавить админа @юз - назначить админа бота',
          '/removeadmin @юз, !снять админа @юз - снять вспомогательного администратора бота',
          '/promote @юз [уровень], !повышение @юз [уровень] - повысить администратора (если уровень не указан, повышает на 1)',
          '/demote @юз [уровень], !разжалование @юз [уровень] - понизить администратора (если уровень не указан, понижает на 1)',
      ].join('\n'),
      [
        '📋 Система уровней администраторов',
        '',
        'Уровни (1 = наивысший):',
        '1 — Главный админ (владелец группы). Только владелец получает этот уровень автоматически.',
        '2 — Ведущий админ. Почти все команды модерации (кроме антиспам/антиссылки/антифлуд). Может добавлять и снимать админов ниже себя.',
        '3 — Старший админ. Доступ к ban и управлению пользователями ниже по уровню (может наказывать, но не снимать права).',
        '4 — Средний админ. Доступ к warn и mute и их снятию.',
        '5 — Младший админ. Доступ только к выдаче предупреждений и просмотру варн-листа.',
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

    return {
      text: `${pages[page]}\n\nСтраница ${page + 1}/${pages.length}`,
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
    const username = profile.username || getMentionText(targetUser);
    const punishments = profile.punishments.length
      ? profile.punishments.map((item) => `${item.action}${item.reason ? `: ${item.reason}` : ''}`).join(', ')
      : 'нет';
    const description = profile.description ? profile.description : 'нет';
    const topLabel = profile.topPosition ? `${profile.topPosition} место` : 'не в топе';
    const lastSeenLabel = profile.lastSeenAt ? new Date(profile.lastSeenAt).toLocaleString('ru-RU') : 'неизвестно';
    const chartSvg = buildActivityChartSvg(activity);
    const caption = [
      `📊 Анкета пользователя ${escapeCaptionText(username)}`,
      `Имя: ${escapeCaptionText(profile.displayName || targetUser.first_name || targetUser.username || targetUser.id)}`,
      `Описание: ${escapeCaptionText(description)}`,
      `Наказания: ${escapeCaptionText(punishments)}`,
      `Сообщений: ${escapeCaptionText(profile.messageCount)}`,
      `Место в топе: ${escapeCaptionText(topLabel)}`,
      `Последний вход: ${escapeCaptionText(lastSeenLabel)}`,
      '',
      'Активность за последние 7 дней',
    ].join('\n');

    try {
      const chartPng = await buildActivityChartPng(activity);
      await ctx.replyWithPhoto({ source: chartPng }, {
        caption,
        parse_mode: 'HTML',
      });
    } catch (error) {
      console.error('Failed to convert chart to PNG:', error);
      await ctx.replyWithDocument({ source: Buffer.from(chartSvg, 'utf8'), filename: 'stats.svg' }, {
        caption,
        parse_mode: 'HTML',
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
    const lines = top.map((item, index) => `${index + 1}. ${item.displayName || item.userId} — ${item.messageCount} сообщений`);
    ctx.reply(`🏆 Топ по сообщениям в этой группе:\n${lines.join('\n')}`);
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

  async function warnCommand(ctx, args) {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, '/warn @юз причина');
    if (!targetData) {
      return;
    }

    const details = parsePunishmentDetails(targetData.remainingArgs, !!ctx.message.reply_to_message);
    moderationService.addWarning(ctx.chat.id, targetData.target.id);
    database.addPunishment(ctx.chat.id, targetData.target.id, 'warn', details.reason, null);
    ctx.reply(`Предупреждение для ${targetData.target.first_name || targetData.target.username || targetData.target.id}: ${moderationService.getWarnings(ctx.chat.id, targetData.target.id)}/3. Причина: ${details.reason}`);
  }

  async function warningsCommand(ctx, args = '') {
    ensureGroup(ctx);
    let target = ctx.message.reply_to_message?.from || ctx.from;
    if (args && args.trim()) {
      const targetData = await resolveCommandTarget(ctx, args, '/warnings @юз');
      if (!targetData) {
        return;
      }
      target = targetData.target;
    }
    ctx.reply(`Предупреждений: ${moderationService.getWarnings(ctx.chat.id, target.id)}/3`);
  }

  async function unwarnCommand(ctx, args) {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, '/unwarn @юз');
    if (!targetData) {
      return;
    }

    moderationService.resetWarnings(ctx.chat.id, targetData.target.id);
    ctx.reply(`Предупреждения пользователя ${targetData.target.first_name || targetData.target.username || targetData.target.id} сброшены.`);
  }

  async function muteCommand(ctx, args) {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, '/mute @юз <время> <причина>');
    if (!targetData) {
      return;
    }

    const details = parsePunishmentDetails(targetData.remainingArgs, !!ctx.message.reply_to_message);
    const untilDate = details.durationHours ? Math.floor(Date.now() / 1000) + Math.round(details.durationHours * 3600) : undefined;

    try {
      await ctx.telegram.restrictChatMember(ctx.chat.id, targetData.target.id, buildMutePermissions(false), untilDate);
    } catch (error) {
      ctx.reply('Не удалось применить mute: у бота нет прав администратора или запрет не поддерживается в этом чате.');
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
    ctx.reply(`🔒 ${targetLabel} получил mute на ${durationLabel}. Причина: ${details.reason}`);

    try {
      await ctx.telegram.sendMessage(
        targetData.target.id,
        buildPunishmentNotification('mute', ctx.chat.title || String(ctx.chat.id), details.reason, details.durationHours)
      );
    } catch (error) {
      // ignore private message failures due to privacy settings
    }
  }

  async function unmuteCommand(ctx, args) {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, '/unmute @юз');
    if (!targetData) {
      return;
    }

    try {
      await ctx.telegram.restrictChatMember(ctx.chat.id, targetData.target.id, buildMutePermissions(true));
      database.removeActivePunishment(ctx.chat.id, targetData.target.id, 'mute');
      clearScheduledPunishment(ctx.chat.id, targetData.target.id, 'mute');
    } catch (error) {
      ctx.reply('Не удалось снять mute: у бота нет прав администратора.');
      return;
    }

    ctx.reply(`Ограничения с пользователя ${targetData.target.first_name || targetData.target.username || targetData.target.id} сняты.`);
  }

  async function banCommand(ctx, args) {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, '/ban @юз <время> <причина>');
    if (!targetData) {
      return;
    }

    const details = parsePunishmentDetails(targetData.remainingArgs, !!ctx.message.reply_to_message);
    const untilDate = details.durationHours ? Math.floor(Date.now() / 1000) + Math.round(details.durationHours * 3600) : undefined;

    try {
      await ctx.telegram.banChatMember(ctx.chat.id, targetData.target.id, untilDate);
    } catch (error) {
      ctx.reply('Не удалось выполнить ban: у бота нет прав администратора или пользователь не может быть заблокирован.');
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
    ctx.reply(`⛔ ${targetLabel} получил ban на ${durationLabel}. Причина: ${details.reason}`);

    try {
      await ctx.telegram.sendMessage(
        targetData.target.id,
        buildPunishmentNotification('ban', ctx.chat.title || String(ctx.chat.id), details.reason, details.durationHours)
      );
    } catch (error) {
      // ignore private message failures due to privacy settings
    }
  }

  async function unbanCommand(ctx, args) {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, '/unban @юз');
    if (!targetData) {
      return;
    }

    try {
      await ctx.telegram.unbanChatMember(ctx.chat.id, targetData.target.id, true);
      database.removeActivePunishment(ctx.chat.id, targetData.target.id, 'ban');
      clearScheduledPunishment(ctx.chat.id, targetData.target.id, 'ban');
    } catch (error) {
      ctx.reply('Не удалось снять ban: у бота нет прав администратора.');
      return;
    }

    ctx.reply(`Пользователь ${targetData.target.first_name || targetData.target.username || targetData.target.id} разблокирован.`);
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
      ctx.reply('Только главный или ведущий админ уровня 2 может назначать новых админов.');
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
      ctx.reply('Только главный или ведущий админ уровня 2 может снимать админов.');
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

    if (!isPrimary && (!actorLevel)) {
      ctx.reply('Нельзя выполнять эту команду.');
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
      case 'размут':
        await unmuteCommand(ctx, args);
        return true;
      case 'бан':
        await banCommand(ctx, args);
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

  bot.action(/^help:(\d+)$/, async (ctx) => {
    const pageIndex = Number(ctx.match[1]);
    const helpPage = buildHelpPage(pageIndex);
    await ctx.answerCbQuery();
    await ctx.editMessageText(helpPage.text, { reply_markup: helpPage.reply_markup });
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
      await ctx.answerCbQuery();
      return;
    }
    await ctx.answerCbQuery();

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
      } else if (parsed.section === 'banwords') {
        await showSettingsBanwordsMenu(ctx, chatId);
      } else if (parsed.section === 'anonymous') {
        await showSettingsAnonymousMenu(ctx, chatId);
      } else if (parsed.section === 'commands') {
        // Open interactive command rights UI (same as /menu)
        await showMenuCommandRightsMenu(ctx, chatId, 0);
      }
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

    if (parsed.target === 'toggle_captcha') {
      if (parsed.value === 'on') {
        moderationService.enableCaptcha(chatId);
      } else {
        moderationService.disableCaptcha(chatId);
      }
      await showSettingsCaptchaMenu(ctx, chatId);
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

    if (parsed.target === 'banword_add') {
      setPendingSettingsAction(ctx, { action: 'settings_banword_add', groupId: chatId });
      await ctx.reply(parseSettingsPrompt('settings_banword_add'));
      return;
    }

    if (parsed.target === 'banword_remove') {
      setPendingSettingsAction(ctx, { action: 'settings_banword_remove', groupId: chatId });
      await ctx.reply(parseSettingsPrompt('settings_banword_remove'));
      return;
    }

    if (parsed.target === 'banword_list') {
      await showSettingsBanwordsMenu(ctx, chatId);
      return;
    }
  });

  bot.action(/^admin_report:(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    await ctx.answerCbQuery();
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
    setPendingSettingsAction(ctx, { action: 'admin_report_write', reportId, groupId: ctx.chat.id });
    await ctx.reply('Напишите краткий отчёт по жалобе. После отправки ваше сообщение будет удалено и включено в уведомление.');
    return;
  });

  bot.action(/^menu:(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }
    await ctx.answerCbQuery();

    if (!isBotAdmin(ctx)) {
      await ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    if (action === 'overview' || action === 'first_message') {
      await ctx.editMessageText(formatMenuOverview(chatId), { reply_markup: getMenuKeyboard(chatId) });
      return;
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
      await showMenuCommandRightsMenu(ctx, chatId, 0);
      return;
    }

    if (action.startsWith('command_rights:nav:')) {
      const pageIndex = Number(action.split(':')[2]);
      if (Number.isFinite(pageIndex)) {
        await showMenuCommandRightsMenu(ctx, chatId, pageIndex);
      }
      return;
    }

    if (action.startsWith('command_rights:toggle:')) {
      const parts = action.split(':');
      const commandIndex = Number(parts[2]);
      const newLevel = String(parts[3]);
      const commands = getCommandsList();

      if (Number.isFinite(commandIndex) && commandIndex >= 0 && commandIndex < commands.length) {
        const { cmd } = commands[commandIndex];
        if (['all', 'admin', 'none'].includes(newLevel)) {
          moderationService.setCommandRights(chatId, cmd, newLevel);
          await ctx.answerCbQuery(`✅ Право на ${commands[commandIndex].label} изменено на "${getPermissionLabel(newLevel)}".`);
          // compute page index containing this command
          const pageIndex = Math.floor(commandIndex / COMMANDS_PER_PAGE);
          await showMenuCommandRightsMenu(ctx, chatId, pageIndex);
        }
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

  bot.command(['unmute', 'размут'], async (ctx) => {
    await unmuteCommand(ctx, ctx.message.text.replace(/^\/(?:unmute|размут)\s*/i, ''));
  });

  bot.command(['ban', 'бан'], async (ctx) => {
    await banCommand(ctx, ctx.message.text.replace(/^\/(?:ban|бан)\s*/i, ''));
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
      database.recordMessage(ctx.chat.id, ctx.from.id, getDisplayName(ctx), ctx.from.username);
    }

    // Handle anonymous messages (sender_chat/author_signature) - messages posted through a channel or hidden sender
    if (isGroupChat(ctx) && isAnonymousSenderMessage(message)) {
      const service = activeModerationService || defaultModerationService;
      if (service.isHideAnonymousEnabled(ctx.chat.id)) {
        if (service.shouldDeleteAnonymousMessages(ctx.chat.id)) {
          try {
            await deleteMessageSafely(ctx, message.message_id);
          } catch (error) {
            console.warn('Failed to delete anonymous message:', error?.message || error);
          }
        }
        return;
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
      await deleteMessageSafely(ctx, ctx.message.message_id);
      await applyAutomaticMute(ctx, ctx.from.id, 1, 'Антифлуд');
      return;
    }

    if (isGroupChat(ctx) && moderationService.isSpamProtectionEnabled(ctx.chat.id)) {
      const shouldPunish = trackSpamActivity(ctx);
      if (shouldPunish) {
        const recentMessages = spamActivity.get(ctx.chat.id)?.get(ctx.from.id)?.messages || [];
        if (recentMessages.length) {
          await Promise.all(recentMessages.map((item) => deleteMessageSafely(ctx, item.messageId)));
        }
        await applyAutomaticMute(ctx, ctx.from.id, 24, 'Спам');
        return;
      }
    }

    const rulesEnabled = isGroupChat(ctx) && moderationService.isRulesEnabled(ctx.chat.id);
    if (rulesEnabled) {
      const forbiddenWord = moderationService.findBanWord(ctx.chat.id, text);
      if (forbiddenWord) {
        await deleteMessageSafely(ctx, ctx.message.message_id);
        await applyAutomaticMute(ctx, ctx.from.id, 24, `Запрещённое слово: ${forbiddenWord}`);
        return;
      }
    }

    if (isGroupChat(ctx) && moderationService.isLinkProtectionEnabled(ctx.chat.id) && isLinkMessage(text, (link) => moderationService.isAllowedLink(ctx.chat.id, link))) {
      console.log('anti-link triggered', {
        chatId: ctx.chat.id,
        userId: ctx.from?.id,
        text,
        links: getLinkCandidates(text),
        allowed: getLinkCandidates(text).map((link) => moderationService.isAllowedLink(ctx.chat.id, link)),
      });
      await deleteMessageSafely(ctx, ctx.message.message_id);
      await applyAutomaticMute(ctx, ctx.from.id, 24 * 7, 'Ссылка');
      return;
    }

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

    if (ctx.chat && isGroupChat(ctx) && getPendingMenuAction(ctx)) {
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
  shouldStartCaptchaForChat,
  getCaptchaEmojiSet,
  parsePunishmentDetails,
  buildPunishmentNotification,
  buildModerationAlertMessage,
  buildFunReply,
  parsePageNumber,
  buildPunishmentListMessage,
  buildBotAdminListMessage,
  buildSettingsMainKeyboard,
  buildSettingsCommandRightsKeyboard,
  buildSettingsFirstMessageKeyboard,
  buildSettingsRulesMenuText,
  buildSettingsAnonymousMenuText,
  buildSettingsAnonymousKeyboard,
  isAnonymousSenderMessage,
  isChannelPostInGroupMessage,
  parseSettingsAction,
  detectForbiddenWord,
  isLinkMessage,
  isAllowedLinkUrl,
  isGroupMemberWithProfileChangePermission,
  isGroupMemberWithManageRights,
  getGroupDisplayName,
  startBot,
};

2