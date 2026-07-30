const { Telegraf } = require('telegraf');
const PureImage = require('pureimage');
const { PassThrough } = require('stream');
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

function buildFunReply(kind) {
  if (kind === 'coin') {
    return Math.random() > 0.5 ? 'Орёл' : 'Решка';
  }
  if (kind === 'dice') {
    return String(Math.floor(Math.random() * 6) + 1);
  }
  if (kind === 'fate') {
    const answers = ['Да', 'Нет', 'Возможно', 'Скорее да', 'Скорее нет', 'Никогда не угадаешь'];
    return answers[Math.floor(Math.random() * answers.length)];
  }
  if (kind === 'compliment') {
    const replies = ['у тебя очень приятная энергия', 'ты делаешь этот чат лучше', 'ты невероятно добрый человек', 'ты умеешь вдохновлять'];
    return replies[Math.floor(Math.random() * replies.length)];
  }
  if (kind === 'insult') {
    const replies = ['ты — источник вайба', 'ты удивительно милый человек', 'у тебя очень сильный характер', 'ты даже в шутку звучишь круто'];
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

function buildBotAdminListMessage(primaryAdminId, auxiliaryAdminIds = []) {
  const primaryLabel = primaryAdminId === null || primaryAdminId === undefined ? 'нет' : `User ${primaryAdminId}`;
  const auxiliaryLabels = Array.isArray(auxiliaryAdminIds) ? auxiliaryAdminIds : [];
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

async function buildActivityGraphBuffer(dailyCounts, username) {
  const dates = Object.keys(dailyCounts || {}).sort();
  if (!dates.length) {
    return null;
  }

  const counts = dates.map((date) => Number(dailyCounts[date] || 0));
  const width = 900;
  const height = 450;
  const padding = 60;
  const chartHeight = height - padding * 2.2;
  const chartWidth = width - padding * 2;

  const img = PureImage.make(width, height);
  const ctx = img.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  ctx.font = '24px serif';
  ctx.fillText(`Активность ${username}`, padding, 36);

  const maxCount = Math.max(...counts, 1);
  const x0 = padding;
  const y0 = height - padding;
  const x1 = width - padding;
  const y1 = padding + 20;

  ctx.strokeStyle = '#333333';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y0);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x0, y1);
  ctx.stroke();

  const rows = 5;
  ctx.font = '16px serif';
  ctx.fillStyle = '#444444';
  for (let row = 0; row <= rows; row += 1) {
    const y = y0 - (row * (chartHeight / rows));
    const value = Math.round((maxCount * row) / rows);
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();

    ctx.fillStyle = '#333333';
    ctx.fillText(String(value), 10, y + 5);
  }

  const pointCount = dates.length;
  const stepX = pointCount === 1 ? 0 : chartWidth / Math.max(pointCount - 1, 1);
  const points = dates.map((date, index) => {
    const x = x0 + index * stepX;
    const y = y0 - (counts[index] / maxCount) * chartHeight;
    return { x, y, date, value: counts[index] };
  });

  ctx.strokeStyle = '#1976d2';
  ctx.lineWidth = 4;
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) {
      ctx.moveTo(point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
    }
  });
  ctx.stroke();

  ctx.fillStyle = 'rgba(25, 118, 210, 0.18)';
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) {
      ctx.moveTo(point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
    }
  });
  ctx.lineTo(points[points.length - 1].x, y0);
  ctx.lineTo(points[0].x, y0);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#1976d2';
  points.forEach((point) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.fillStyle = '#000000';
  ctx.font = '14px serif';
  const labelStep = Math.max(1, Math.ceil(pointCount / 6));
  points.forEach((point, index) => {
    if (index % labelStep === 0 || index === pointCount - 1) {
      const label = point.date.slice(5);
      ctx.fillText(label, point.x - 24, y0 + 24);
    }
  });

  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  const pngPromise = new Promise((resolve, reject) => {
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });

  await PureImage.encodePNGToStream(img, stream);
  stream.end();
  return pngPromise;
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

  function isKnownCommandText(text) {
    const slashCommand = /^\/(start|help|id|about|whoami|stats|rules|hug|kiss|slap|poke|coin|dice|fate|compliment|insult|top|admins|banlist|mutelist|setrules|warn|warnings|unwarn|mute|unmute|ban|unban|setgreeting|addbotadmin|ai)(\s|$)/i;
    const bangCommand = /^!(начало|помощь|айди|информация|кто\s*я|статистика|правила|обнять|поцеловать|шлёпнуть|тыкнуть|монетка|кубик|вопрос|комплимент|похвала)(\s|$)/i;
    const plusMinusCommand = /^(\+антиспам|\+antispam|\-антиспам|\-antispam|\+ссылки|\+links|\-ссылки|\-links|\+описание|\+description|\+rules|\+правила|\+greeting|\+приветствие)(\s|$)/i;
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

  async function applyAutomaticMute(ctx, userId, durationHours, reason) {
    const untilDate = Math.floor(Date.now() / 1000) + Math.round(durationHours * 3600);
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

  function helpCommand(ctx) {
    ctx.reply([
      '📋 СПРАВКА ПО КОМАНДАМ',
      '',
      '👤 ПОЛЬЗОВАТЕЛЬСКИЕ КОМАНДЫ',
      '/start, !начало - начать работу',
      '/help, !помощь - показать эту справку',
      '/id, !айди - показать ваши ID',
      '/about, !информация - информация о боте',
      '/whoami, !кто я - забавное описание вас',
      '',
      '👮 МОДЕРСКИЕ КОМАНДЫ',
      '/rules, !правила - показать правила чата',
      '/setrules, !установить правила <текст> - установить правила',
      '/setgreeting, !установить приветствие <текст> - установить приветствие',
      '+антиспам - включить антиспам',
      '-антиспам - выключить антиспам',
      '+ссылки - включить антиссылки',
      '-ссылки - выключить антиссылки',
      '/warn, !предупреждение - выдать предупреждение',
      '/warnings, !варны - показать варны пользователя',
      '/unwarn, !снять предупреждение - снять предупреждения',
      '/mute, !мут <время> <причина> - ограничить сообщения',
      '/unmute, !размут - снять ограничение',
      '/ban, !бан <время> <причина> - заблокировать пользователя',
      '/unban, !разбан - разблокировать пользователя',
      '/banlist, !баны [страница] - список активных банов',
      '/mutelist, !муты [страница] - список активных мутов',
      '/admins, !админы - список администраторов бота',
      '/addbotadmin, !добавить админа - назначить админа бота (ответом на сообщение)',
      '/stats, !статистика - личная статистика пользователя',
      '/top, !топ - топ пользователей по сообщениям в группе',
      '',
      '🎉 РАЗВЛЕЧЕНИЯ',
      '/hug @username, !обнять @username - обнять пользователя',
      '/kiss @username, !поцеловать @username - поцеловать пользователя',
      '/slap @username, !шлепнуть @username - шлёпнуть пользователя',
      '/poke @username, !тыкнуть @username - ткнуть пользователя',
      '/coin, !монетка - подбросить монетку',
      '/dice, !кубик - бросить кубик',
      '/fate, !вопрос - спросить судьбу',
      '/compliment, !комплимент - получить комплимент',
      '/insult, !похвала - получить приятную шутку',
      '/ai <текст> - спросить AI и получить ответ',
      '',
      'Используйте русские команды с ! и английские с /',
    ].join('\n'));
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
      const content = await ai.requestAi(trimmedPrompt, {
        apiKey: config.aiApiKey,
        apiBaseUrl: config.aiApiBaseUrl,
        model: config.aiModel,
        weatherLocation: config.weatherLocation,
      });

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
    const target = await resolveRoleplayTarget(ctx, args, `/${action} @username`);
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

  async function statsCommand(ctx, args) {
    ensureGroup(ctx);

    let targetUser = ctx.message.reply_to_message?.from || ctx.from;
    if (args && args.trim()) {
      const targetData = await resolveCommandTarget(ctx, args, '/stats @username');
      if (!targetData) {
        return;
      }
      targetUser = targetData.target;
    }

    const profile = database.getUserProfile(ctx.chat.id, targetUser.id);
    const username = profile.username || getMentionText(targetUser);
    const punishments = profile.punishments.length
      ? profile.punishments.map((item) => `${item.action}${item.reason ? `: ${item.reason}` : ''}`).join(', ')
      : 'нет';
    const description = profile.description ? profile.description : 'нет';
    const topLabel = profile.topPosition ? `${profile.topPosition} место` : 'не в топе';
    const lastSeenLabel = profile.lastSeenAt ? new Date(profile.lastSeenAt).toLocaleString('ru-RU') : 'неизвестно';

    const text = [
      `📊 Анкета пользователя ${username}`,
      `Имя: ${profile.displayName || targetUser.first_name || targetUser.username || targetUser.id}`,
      `Описание: ${description}`,
      `Наказания: ${punishments}`,
      `Сообщений: ${profile.messageCount}`,
      `Место в топе: ${topLabel}`,
      `Последний вход: ${lastSeenLabel}`,
    ].join('\n');

    const graphBuffer = await buildActivityGraphBuffer(profile.dailyCounts, username);
    if (graphBuffer) {
      await ctx.replyWithPhoto({ source: graphBuffer }, { caption: text });
      return;
    }

    ctx.reply(text);
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
    const primaryAdminId = database.getPrimaryBotAdmin(ctx.chat.id);
    const auxiliaryAdminIds = database.getAuxiliaryBotAdmins(ctx.chat.id);
    const labels = auxiliaryAdminIds.map((userId) => {
      const profile = database.getUserProfile(ctx.chat.id, userId);
      if (profile?.displayName) {
        return `${profile.displayName} (${userId})`;
      }
      if (profile?.username) {
        return `${profile.username} (${userId})`;
      }
      return `User ${userId}`;
    });
    const primaryLabel = primaryAdminId === null || primaryAdminId === undefined
      ? 'нет'
      : (() => {
          const profile = database.getUserProfile(ctx.chat.id, primaryAdminId);
          if (profile?.displayName) {
            return `${profile.displayName} (${primaryAdminId})`;
          }
          if (profile?.username) {
            return `${profile.username} (${primaryAdminId})`;
          }
          return `User ${primaryAdminId}`;
        })();

    ctx.reply(buildBotAdminListMessage(primaryAdminId, labels));
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

    const targetData = await resolveCommandTarget(ctx, args, '/warn @username причина');
    if (!targetData) {
      return;
    }

    const details = parsePunishmentDetails(targetData.remainingArgs, !!ctx.message.reply_to_message);
    moderationService.addWarning(ctx.chat.id, targetData.target.id);
    database.addPunishment(ctx.chat.id, targetData.target.id, 'warn', details.reason, null);
    ctx.reply(`Предупреждение для ${targetData.target.first_name || targetData.target.username || targetData.target.id}: ${moderationService.getWarnings(ctx.chat.id, targetData.target.id)}/3. Причина: ${details.reason}`);
  }

  function warningsCommand(ctx) {
    ensureGroup(ctx);
    const target = ctx.message.reply_to_message?.from || ctx.from;
    ctx.reply(`Предупреждений: ${moderationService.getWarnings(ctx.chat.id, target.id)}/3`);
  }

  async function unwarnCommand(ctx, args) {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, args, '/unwarn @username');
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

    const targetData = await resolveCommandTarget(ctx, args, '/mute @username <время> <причина>');
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

    const targetData = await resolveCommandTarget(ctx, args, '/unmute @username');
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

    const targetData = await resolveCommandTarget(ctx, args, '/ban @username <время> <причина>');
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

    const targetData = await resolveCommandTarget(ctx, args, '/unban @username');
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

  function addBotAdminCommand(ctx) {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Только главный или вспомогательный администратор бота может добавлять новых админов.');
      return;
    }

    const target = ctx.message.reply_to_message?.from;
    if (!target) {
      ctx.reply('Ответьте на сообщение пользователя, которого хотите сделать администратором бота.');
      return;
    }

    const isPrimary = database.isPrimaryBotAdmin(ctx.chat.id, ctx.from.id);
    if (!isPrimary && target.id === ctx.from.id) {
      ctx.reply('Нельзя назначить себя дополнительным администратором.');
      return;
    }

    database.addBotAdmin(ctx.chat.id, target.id);
    ctx.reply(`Пользователь ${target.first_name || target.username || target.id} добавлен как вспомогательный администратор бота.`);
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
        warningsCommand(ctx);
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
          addBotAdminCommand(ctx);
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

  bot.command(['id', 'айди'], (ctx) => {
    ctx.reply(`Ваш Telegram ID: ${ctx.from.id}\nID чата: ${ctx.chat.id}`);
  });

  bot.command(['about', 'информация'], (ctx) => {
    ctx.reply(`${config.botName}\nПолноценный бот на Node.js.`);
  });

  bot.command(['whoami', 'кто_я'], (ctx) => {
    ctx.reply(`${ctx.from.first_name || 'Пользователь'}, ${getFunnyDescription()}`);
  });

  bot.command(['stats', 'статистика'], async (ctx) => {
    const args = ctx.message.text.replace(/^\/(?:stats|статистика)\s*/i, '');
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

  bot.command(['insult', 'похвала'], (ctx) => {
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

  bot.command(['warnings', 'варны'], (ctx) => {
    ensureGroup(ctx);
    const target = ctx.message.reply_to_message?.from || ctx.from;
    ctx.reply(`Предупреждений: ${moderationService.getWarnings(ctx.chat.id, target.id)}/3`);
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

  bot.command(['addbotadmin', 'добавить_админа'], (ctx) => {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Только главный или вспомогательный администратор бота может добавлять новых админов.');
      return;
    }

    const target = ctx.message.reply_to_message?.from;
    if (!target) {
      ctx.reply('Ответьте на сообщение пользователя, которого хотите сделать администратором бота.');
      return;
    }

    const isPrimary = database.isPrimaryBotAdmin(ctx.chat.id, ctx.from.id);
    if (!isPrimary && target.id === ctx.from.id) {
      ctx.reply('Нельзя назначить себя дополнительным администратором.');
      return;
    }

    database.addBotAdmin(ctx.chat.id, target.id);
    ctx.reply(`Пользователь ${target.first_name || target.username || target.id} добавлен как вспомогательный администратор бота.`);
  });

  bot.on('text', async (ctx) => {
    if (!ctx.message.text) {
      return;
    }

    const text = ctx.message.text.trim();
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
      moderationService.enableSpamProtection(ctx.chat.id);
      ctx.reply('✅ Антиспам включён.');
      return;
    }

    if (text.startsWith('-антиспам')) {
      ensureGroup(ctx);
      if (!isBotAdmin(ctx)) {
        ctx.reply('Эта команда доступна только администраторам.');
        return;
      }
      moderationService.disableSpamProtection(ctx.chat.id);
      ctx.reply('✅ Антиспам выключен.');
      return;
    }

    if (text.startsWith('+ссылки') || text.startsWith('+links')) {
      ensureGroup(ctx);
      if (!isBotAdmin(ctx)) {
        ctx.reply('Эта команда доступна только администраторам.');
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

    // Обработка текстовых команд: +rules, +greeting
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

    // Обработка фильтров
    const response = moderationService.findFilterResponse(ctx.chat.id, text);
    if (response) {
      ctx.reply(response);
      return;
    }

    if (isPrivateChat(ctx)) {
      await handlePrivateAIMessages(ctx, text);
      return;
    }
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
  buildFunReply,
  parsePageNumber,
  buildPunishmentListMessage,
  buildBotAdminListMessage,
  startBot,
};
