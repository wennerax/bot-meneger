const { Telegraf } = require('telegraf');
const sharp = require('sharp');
const { loadConfig } = require('./config');
const UserService = require('./services/user_service');
const ModerationService = require('./services/moderation_service');
const Database = require('./services/database');
const { getFunnyDescription } = require('./services/moderation_service');
const { getMentionText, resolveUsernameTarget } = require('./services/username_service');

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
    const primaryLabel = primaryAdminLabel || 'нет';
    const auxiliaryLabels = Array.isArray(auxiliaryAdminLabels) ? auxiliaryAdminLabels : [];
  const lines = [
    '🤖 Администраторы бота',
    `Главный администратор: ${primaryLabel}`,
  ];

  if (auxiliaryLabels.length) {
    lines.push('Вспомогательные администраторы:');
    auxiliaryLabels.forEach((label, index) => {
      lines.push(`${index + 1}. ${label}`);
    });
  } else {
    lines.push('Вспомогательные администраторы: нет');
  }

  return lines.join('\n');
}

const ai = require('./ai');

function createBot() {
  const config = loadConfig();
  const bot = new Telegraf(config.botToken || '');
  const userService = new UserService();
  const moderationService = new ModerationService();
  const database = new Database(config.databasePath);
  const punishmentTimers = new Map();
  const spamActivity = new Map();
  const messageHistory = new Map();
  const captchaStates = new Map();

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

  function getCaptchaEmojiSet() {
    const emojis = ['🐶', '🐱', '🦊', '🐼'];
    const target = emojis[Math.floor(Math.random() * emojis.length)];
    const options = emojis.filter((emoji) => emoji !== target);
    const shuffled = [...options, target].sort(() => Math.random() - 0.5);
    return { target, options: shuffled };
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
    const { target, options } = getCaptchaEmojiSet();
    const shuffledOptions = [...options, target].sort(() => Math.random() - 0.5);
    const correctOptionId = shuffledOptions.indexOf(target);

    let pollMessage;
    try {
      pollMessage = await ctx.telegram.sendPoll(chatId,
        `Капча для пользователя ${displayName}. Выбери ${target}`,
        shuffledOptions,
        {
          type: 'quiz',
          correct_option_id: correctOptionId,
          is_anonymous: false,
          open_period: 300,
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

  function getCallerAdminLevel(ctx) {
    const userId = ctx.from?.id;
    if (!userId) {
      return null;
    }
    if (config.adminIds.includes(userId)) {
      return 1;
    }
    return database.getBotAdminLevel(ctx.chat.id, userId);
  }

  function hasAdminLevel(ctx, maxLevel) {
    const level = getCallerAdminLevel(ctx);
    return level !== null && level !== undefined && Number(level) <= Number(maxLevel);
  }

  function canActOnTarget(ctx, targetId) {
    // determines whether caller (ctx.from) can moderate the target userId in this chat
    const chatId = ctx.chat.id;
    const callerId = ctx.from?.id;
    if (!callerId) return false;
    if (targetId === callerId) {
      return false;
    }

    // primary owner cannot be acted upon by anyone
    if (database.isPrimaryBotAdmin(chatId, targetId)) {
      return false;
    }

    // owner can act on anyone
    if (database.isPrimaryBotAdmin(chatId, callerId) || config.adminIds.includes(callerId)) {
      return true;
    }

    const callerLevel = database.getBotAdminLevel(chatId, callerId);
    if (callerLevel === null || callerLevel === undefined) {
      return false;
    }

    const targetLevel = database.getBotAdminLevel(chatId, targetId);

    // if target is not a bot-admin (no level), action allowed
    if (targetLevel === null || targetLevel === undefined) {
      return true;
    }

    // allow action only when target has a numerically higher level (less privileges)
    return Number(targetLevel) > Number(callerLevel);
  }

  function buildAdminLevelName(level) {
    switch (Number(level)) {
      case 1:
        return 'Главный админ';
      case 2:
        return 'Ведущий админ';
      case 3:
        return 'Старший админ';
      case 4:
        return 'Средний админ';
      case 5:
        return 'Младший админ';
      default:
        return `уровень ${level}`;
    }
  }

  function parseAdminLevel(value) {
    const level = Number(value);
    if (!Number.isFinite(level) || level < 1 || level > 5) {
      return null;
    }
    return level;
  }

  async function adjustBotAdminLevelCommand(ctx, args, action) {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Только администраторы бота могут изменять уровни других админов.');
      return;
    }

    const callerId = ctx.from?.id;
    if (!callerId) {
      return;
    }

    const callerIsPrimary = database.isPrimaryBotAdmin(ctx.chat.id, callerId) || config.adminIds.includes(callerId);
    const callerLevel = database.getBotAdminLevel(ctx.chat.id, callerId) || (callerIsPrimary ? 1 : null);
    if (!callerIsPrimary && (callerLevel === null || callerLevel > 2)) {
      ctx.reply('Только главный админ или ведущий админ (уровень 2) может изменять уровни админов.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, action === 'promote' ? '/повышение @юз [уровень]' : '/разжалование @юз [уровень]');
    if (!targetData) {
      return;
    }

    const target = targetData.target;
    if (target.id === callerId) {
      ctx.reply('Нельзя изменять уровень самому себе.');
      return;
    }

    if (database.isPrimaryBotAdmin(ctx.chat.id, target.id)) {
      ctx.reply('Нельзя изменять уровень главного администратора.');
      return;
    }

    const targetLevel = database.getBotAdminLevel(ctx.chat.id, target.id);
    const explicitLevel = parseAdminLevel(targetData.remainingArgs);
    let newLevel = null;

    if (action === 'promote') {
      if (targetLevel === null || targetLevel === undefined) {
        newLevel = explicitLevel || 5;
      } else {
        if (explicitLevel !== null) {
          newLevel = explicitLevel;
        } else {
          newLevel = Math.max(1, targetLevel - 1);
        }
      }

      if (newLevel === targetLevel) {
        ctx.reply('У этого пользователя уже такой уровень. Укажите другой уровень.');
        return;
      }

      if (!callerIsPrimary && Number(newLevel) <= Number(callerLevel)) {
        ctx.reply('Нельзя повысить пользователя до вашего уровня или выше.');
        return;
      }

      if (targetLevel !== null && Number(newLevel) >= Number(targetLevel)) {
        ctx.reply('Нельзя повысить пользователя до того же или более низкого уровня.');
        return;
      }

      database.addBotAdmin(ctx.chat.id, target.id, newLevel);
      const levelName = buildAdminLevelName(newLevel);
      if (targetLevel === null || targetLevel === undefined) {
        ctx.reply(`Пользователь ${getMentionText(target)} назначен ${levelName} (уровень ${newLevel}).`);
      } else {
        ctx.reply(`Пользователь ${getMentionText(target)} повышен до ${levelName} (уровень ${newLevel}).`);
      }
      return;
    }

    // demote
    if (targetLevel === null || targetLevel === undefined) {
      ctx.reply('Этот пользователь не является администратором бота.');
      return;
    }

    if (explicitLevel !== null) {
      newLevel = explicitLevel;
    } else {
      newLevel = Math.min(5, targetLevel + 1);
    }

    if (newLevel === targetLevel) {
      ctx.reply('У этого пользователя уже такой уровень. Укажите другой уровень.');
      return;
    }

    if (!callerIsPrimary && Number(newLevel) <= Number(callerLevel)) {
      ctx.reply('Нельзя разжаловать пользователя до вашего уровня или выше.');
      return;
    }

    if (Number(newLevel) <= Number(targetLevel)) {
      ctx.reply('Нельзя разжаловать пользователя до того же или более высокого уровня.');
      return;
    }

    database.addBotAdmin(ctx.chat.id, target.id, newLevel);
    const levelName = buildAdminLevelName(newLevel);
    ctx.reply(`Пользователь ${getMentionText(target)} понижен до ${levelName} (уровень ${newLevel}).`);
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
    const slashCommand = /^\/(start|help|id|about|whoami|stats|rules|hug|kiss|slap|poke|coin|dice|fate|compliment|insult|top|admins|banlist|mutelist|setrules|warn|warnings|unwarn|mute|unmute|ban|unban|setgreeting|addbotadmin|ai)(\s|$)/i;
    const bangCommand = /^!(начало|помощь|айди|информация|кто\s*я|статистика|правила|обнять|поцеловать|шлёпнуть|тыкнуть|монетка|кубик|вопрос|комплимент|инсульт)(\s|$)/i;
    const plusMinusCommand = /^(\+антиспам|\+antispam|\+антифлуд|\+antiflood|\-антиспам|\-antispam|\-антифлуд|\-antiflood|\+ссылки|\+links|\-ссылки|\-links|\+описание|\+description|\+rules|\+правила|\+greeting|\+приветствие)(\s|$)/i;
    return slashCommand.test(text) || bangCommand.test(text) || plusMinusCommand.test(text);
  }

  function ensureGroup(ctx) {
    database.ensureGroup(ctx.chat.id, ctx.chat.title || String(ctx.chat.id), ctx.chat?.owner_id || null);
  }

  function isLinkMessage(text) {
    return /(?:https?:\/\/|www\.)\S+/i.test(text) || /(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?/i.test(text);
  }

  async function deleteMessageSafely(ctx, messageId) {
    if (!messageId) {
      return;
    }
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, messageId);
    } catch (error) {
      // ignore missing permissions or already deleted messages
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

    let ownerId = chatData.owner_id ?? null;
    if (!ownerId) {
      try {
        const chat = await ctx.telegram.getChat(chatId);
        ownerId = chat?.owner_id ?? null;
      } catch (error) {
        ownerId = null;
      }
    }

    if (!ownerId) {
      try {
        const admins = await ctx.telegram.getChatAdministrators(chatId);
        const creator = admins.find((member) => member.status === 'creator');
        ownerId = creator?.user?.id ?? null;
      } catch (error) {
        ownerId = null;
      }
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
        '/addbotadmin @юз, !добавить админа @юз - назначить админа бота',
        '/removebotadmin @юз, !снять админа @юз - снять вспомогательного администратора бота',
        '/promote @юз [уровень], !повышение @юз [уровень] - повысить уровень админа (или назначить младшим админом)',
        '/demote @юз [уровень], !разжалование @юз [уровень] - понизить уровень админа',
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
    const helpPage = buildHelpPage(0);
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
    if (kind === 'mute' && !hasAdminLevel(ctx, 4)) {
      ctx.reply('Эта команда доступна администраторам уровня 4 и выше.');
      return;
    }
    if (kind === 'ban' && !hasAdminLevel(ctx, 3)) {
      ctx.reply('Эта команда доступна администраторам уровня 3 и выше.');
      return;
    }

    const page = parsePageNumber(args);
    const punishments = kind === 'mute'
      ? database.getActivePunishments(ctx.chat.id).filter((item) => item.action === 'mute')
      : database.getActivePunishments(ctx.chat.id).filter((item) => item.action === 'ban');

    ctx.reply(buildPunishmentListMessage(kind, punishments, page, 10));
  }

  function buildBotAdminLabel(ctx, userId) {
    const profile = database.getUserProfile(ctx.chat.id, userId);
    const label = profile?.username || profile?.displayName || `User ${userId}`;
    const level = database.getBotAdminLevel(ctx.chat.id, userId);
    const levelLabel = level ? ` (уровень ${level})` : '';
    return `${label}${levelLabel}`;
  }

  function listBotAdminsCommand(ctx) {
    ensureGroup(ctx);
    const primaryAdminId = database.getPrimaryBotAdmin(ctx.chat.id);
    const auxiliaryAdminIds = database.getAuxiliaryBotAdmins(ctx.chat.id);

    const primaryLabel = primaryAdminId === null || primaryAdminId === undefined
      ? 'нет'
      : `${buildBotAdminLabel(ctx, primaryAdminId)}`;

    const lines = [
      '🤖 Администраторы бота',
      `Главный администратор: ${primaryLabel}`,
    ];

    if (auxiliaryAdminIds.length) {
      lines.push('Вспомогательные администраторы:');
      auxiliaryAdminIds.forEach((userId, index) => {
        lines.push(`${index + 1}. ${buildBotAdminLabel(ctx, userId)}`);
      });
    } else {
      lines.push('Вспомогательные администраторы: нет');
    }

    ctx.reply(lines.join('\n'));
  }

  function rulesCommand(ctx) {
    ctx.reply(moderationService.getRules(ctx.chat.id));
  }

  function setRulesCommand(ctx, args) {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    if (!hasAdminLevel(ctx, 3)) {
      ctx.reply('Эта команда доступна администраторам уровня 3 и выше.');
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
    if (!canActOnTarget(ctx, targetData.target.id)) {
      ctx.reply('Нельзя наказать этого пользователя — он админ с уровнем не ниже вашего.');
      return;
    }

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

    if (!canActOnTarget(ctx, targetData.target.id)) {
      ctx.reply('Нельзя снимать предупреждения у этого пользователя — он админ с уровнем не ниже вашего.');
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
    if (!hasAdminLevel(ctx, 4)) {
      ctx.reply('Эта команда доступна администраторам уровня 4 и выше.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, '/mute @юз <время> <причина>');
    if (!targetData) {
      return;
    }

    const details = parsePunishmentDetails(targetData.remainingArgs, !!ctx.message.reply_to_message);
    const untilDate = details.durationHours ? Math.floor(Date.now() / 1000) + Math.round(details.durationHours * 3600) : undefined;

    if (!canActOnTarget(ctx, targetData.target.id)) {
      ctx.reply('Нельзя наказать этого пользователя — он админ с уровнем не ниже вашего.');
      return;
    }

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
    if (!hasAdminLevel(ctx, 4)) {
      ctx.reply('Эта команда доступна администраторам уровня 4 и выше.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, '/unmute @юз');
    if (!targetData) {
      return;
    }

    if (!canActOnTarget(ctx, targetData.target.id)) {
      ctx.reply('Нельзя снимать ограничения у этого пользователя — он админ с уровнем не ниже вашего.');
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
    if (!hasAdminLevel(ctx, 3)) {
      ctx.reply('Эта команда доступна администраторам уровня 3 и выше.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, '/ban @юз <время> <причина>');
    if (!targetData) {
      return;
    }

    const details = parsePunishmentDetails(targetData.remainingArgs, !!ctx.message.reply_to_message);
    const untilDate = details.durationHours ? Math.floor(Date.now() / 1000) + Math.round(details.durationHours * 3600) : undefined;

    if (!canActOnTarget(ctx, targetData.target.id)) {
      ctx.reply('Нельзя наказать этого пользователя — он админ с уровнем не ниже вашего.');
      return;
    }

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
    if (!hasAdminLevel(ctx, 3)) {
      ctx.reply('Эта команда доступна администраторам уровня 3 и выше.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, '/unban @юз');
    if (!targetData) {
      return;
    }

    if (!canActOnTarget(ctx, targetData.target.id)) {
      ctx.reply('Нельзя снимать блокировку у этого пользователя — он админ с уровнем не ниже вашего.');
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
    if (!hasAdminLevel(ctx, 3)) {
      ctx.reply('Эта команда доступна администраторам уровня 3 и выше.');
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

    const targetData = await resolveCommandTarget(ctx, args, '/addbotadmin @юз');
    if (!targetData) {
      return;
    }

    const target = targetData.target;
    const callerIsPrimary = database.isPrimaryBotAdmin(ctx.chat.id, ctx.from.id) || config.adminIds.includes(ctx.from.id);
    const callerLevel = database.getBotAdminLevel(ctx.chat.id, ctx.from.id) || (callerIsPrimary ? 1 : null);

    // Only primary (owner) or level 2 (ведущий админ) may add new bot admins
    if (!callerIsPrimary && (callerLevel === null || callerLevel > 2)) {
      ctx.reply('Только главный админ или ведущий админ (уровень 2) может добавлять админов.');
      return;
    }

    if (!callerIsPrimary && target.id === ctx.from.id) {
      ctx.reply('Нельзя назначить себя дополнительным администратором.');
      return;
    }

    // New admins default to младший уровень (5). Ensure new level is not higher (numerically lower) than caller's level
    const newLevel = 5;
    if (!callerIsPrimary && Number(newLevel) < Number(callerLevel)) {
      ctx.reply('Нельзя назначить админа с уровнем выше, чем у вас.');
      return;
    }

    database.addBotAdmin(ctx.chat.id, target.id, newLevel);
    ctx.reply(`Пользователь ${target.first_name || target.username || target.id} добавлен как вспомогательный администратор бота (уровень ${newLevel}).`);
  }

  async function removeBotAdminCommand(ctx, args = '') {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Только главный или вспомогательный администратор бота может снимать админов.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, '/removebotadmin @юз');
    if (!targetData) {
      return;
    }

    const target = targetData.target;
    if (database.isPrimaryBotAdmin(ctx.chat.id, target.id)) {
      ctx.reply('Нельзя снять главного администратора бота.');
      return;
    }

    if (target.id === ctx.from.id) {
      ctx.reply('Нельзя снять себя с роли администратора бота.');
      return;
    }

    const callerIsPrimary = database.isPrimaryBotAdmin(ctx.chat.id, ctx.from.id) || config.adminIds.includes(ctx.from.id);
    const callerLevel = database.getBotAdminLevel(ctx.chat.id, ctx.from.id) || (callerIsPrimary ? 1 : null);
    // Only primary or level 2 (ведущий админ) and above can remove admins
    if (!callerIsPrimary && (callerLevel === null || callerLevel > 2)) {
      ctx.reply('Только главный админ или ведущий админ (уровень 2) может снимать админов.');
      return;
    }

    const targetLevel = database.getBotAdminLevel(ctx.chat.id, target.id);
    if (targetLevel !== null && callerIsPrimary === false && Number(targetLevel) < Number(callerLevel)) {
      ctx.reply('Нельзя снимать админа с уровнем выше, чем у вас.');
      return;
    }

    if (!database.removeBotAdmin(ctx.chat.id, target.id)) {
      ctx.reply('Этот пользователь не является вспомогательным администратором бота.');
      return;
    }

    ctx.reply(`Пользователь ${target.first_name || target.username || target.id} больше не является вспомогательным администратором бота.`);
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
        await statsCommand(ctx, args);
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
      case 'повышение':
        await adjustBotAdminLevelCommand(ctx, args, 'promote');
        return true;
      case 'разжалование':
        await adjustBotAdminLevelCommand(ctx, args, 'demote');
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
    ctx.reply(moderationService.getRules(ctx.chat.id));
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

  bot.command(['addbotadmin', 'добавить_админа'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:addbotadmin|добавить_админа)(?:@[\w_]+)?\s*/i, '');
    await addBotAdminCommand(ctx, args);
  });
 
  bot.command(['removebotadmin', 'снять_админа'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:removebotadmin|снять_админа)(?:@[\w_]+)?\s*/i, '');
    await removeBotAdminCommand(ctx, args);
  });

  bot.command(['promote', 'повышение'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:promote|повышение)(?:@[\w_]+)?\s*/i, '');
    await adjustBotAdminLevelCommand(ctx, args, 'promote');
  });

  bot.command(['demote', 'разжалование'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:demote|разжалование)(?:@[\w_]+)?\s*/i, '');
    await adjustBotAdminLevelCommand(ctx, args, 'demote');
  });

  async function handleIncomingMessage(ctx) {
    const message = ctx.message;
    if (!message) {
      return;
    }

    const text = getMessageText(ctx);
    const hasMessageContent = Boolean(text || isMediaMessage(ctx));
    if (!hasMessageContent) {
      return;
    }

    if (isGroupChat(ctx)) {
      database.recordMessage(ctx.chat.id, ctx.from.id, getDisplayName(ctx), ctx.from.username);
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

    if (text.startsWith('+антиспам') || text.startsWith('+antispam')) {
      ensureGroup(ctx);
      if (!isBotAdmin(ctx)) {
        ctx.reply('Эта команда доступна только администраторам.');
        return;
      }
      if (!hasAdminLevel(ctx, 1)) {
        ctx.reply('Эта команда доступна только главному администратору.');
        return;
      }
      moderationService.enableSpamProtection(ctx.chat.id);
      ctx.reply('✅ Антиспам включён.');
      return;
    }

    if (text.startsWith('-антиспам') || text.startsWith('-antispam')) {
      ensureGroup(ctx);
      if (!isBotAdmin(ctx)) {
        ctx.reply('Эта команда доступна только администраторам.');
        return;
      }
      if (!hasAdminLevel(ctx, 1)) {
        ctx.reply('Эта команда доступна только главному администратору.');
        return;
      }
      moderationService.disableSpamProtection(ctx.chat.id);
      ctx.reply('✅ Антиспам выключен.');
      return;
    }

    if (text.startsWith('+антифлуд') || text.startsWith('+antiflood')) {
      ensureGroup(ctx);
      if (!isBotAdmin(ctx)) {
        ctx.reply('Эта команда доступна только администраторам.');
        return;
      }
      if (!hasAdminLevel(ctx, 1)) {
        ctx.reply('Эта команда доступна только главному администратору.');
        return;
      }
      moderationService.enableFloodProtection(ctx.chat.id);
      ctx.reply('✅ Антифлуд включён.');
      return;
    }

    if (text.startsWith('-антифлуд') || text.startsWith('-antiflood')) {
      ensureGroup(ctx);
      if (!isBotAdmin(ctx)) {
        ctx.reply('Эта команда доступна только администраторам.');
        return;
      }
      if (!hasAdminLevel(ctx, 1)) {
        ctx.reply('Эта команда доступна только главному администратору.');
        return;
      }
      moderationService.disableFloodProtection(ctx.chat.id);
      ctx.reply('✅ Антифлуд выключен.');
      return;
    }

    if (text.startsWith('+ссылки') || text.startsWith('+links')) {
      ensureGroup(ctx);
      if (!isBotAdmin(ctx)) {
        ctx.reply('Эта команда доступна только администраторам.');
        return;
      }
      if (!hasAdminLevel(ctx, 1)) {
        ctx.reply('Эта команда доступна только главному администратору.');
        return;
      }
      moderationService.enableLinkProtection(ctx.chat.id);
      ctx.reply('✅ Антиссылки включены.');
      return;
    }

    if (text.startsWith('-ссылки') || text.startsWith('-links')) {
      ensureGroup(ctx);
      if (!isBotAdmin(ctx)) {
        ctx.reply('Эта команда доступна только администраторам.');
        return;
      }
      if (!hasAdminLevel(ctx, 1)) {
        ctx.reply('Эта команда доступна только главному администратору.');
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

    if (text.startsWith('+rules ') || text.startsWith('+правила ')) {
      if (!isBotAdmin(ctx)) {
        ctx.reply('Эта команда доступна только администраторам.');
        return;
      }
      ensureGroup(ctx);
      const newRules = text.startsWith('+rules') ? text.slice(7) : text.slice(10);
      if (!newRules.trim()) {
        ctx.reply('Использование: +rules новые правила или +правила новые правила');
        return;
      }
      moderationService.setRules(ctx.chat.id, newRules.trim());
      ctx.reply('✅ Правила чата обновлены.');
      return;
    }

    if (text.startsWith('+greeting ') || text.startsWith('+приветствие ')) {
      if (!isBotAdmin(ctx)) {
        ctx.reply('Эта команда доступна только администраторам.');
        return;
      }
      ensureGroup(ctx);
      const newGreeting = text.startsWith('+greeting') ? text.slice(10) : text.slice(13);
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

    if (isGroupChat(ctx) && moderationService.isLinkProtectionEnabled(ctx.chat.id) && isLinkMessage(text)) {
      await deleteMessageSafely(ctx, ctx.message.message_id);
      await applyAutomaticMute(ctx, ctx.from.id, 24 * 7, 'Ссылка');
      return;
    }

    const response = moderationService.findFilterResponse(ctx.chat.id, text);
    if (response) {
      ctx.reply(response);
      return;
    }

    if (isPrivateChat(ctx)) {
      await handlePrivateAIMessages(ctx, text);
      return;
    }
  }

  bot.on(['text', 'photo', 'video', 'document', 'animation', 'audio', 'voice', 'sticker', 'video_note'], async (ctx) => {
    await handleIncomingMessage(ctx);
  });

  return { bot, config, userService, moderationService, database };
}

function startBot() {
  const { bot, config } = createBot();
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
  parsePunishmentDetails,
  buildPunishmentNotification,
  buildModerationAlertMessage,
  buildFunReply,
  parsePageNumber,
  buildPunishmentListMessage,
  buildBotAdminListMessage,
  startBot,
};
