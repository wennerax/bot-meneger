const { Telegraf } = require('telegraf');
const { loadConfig } = require('./config');
const UserService = require('./services/user_service');
const ModerationService = require('./services/moderation_service');
const Database = require('./services/database');
const { getFunnyDescription } = require('./services/moderation_service');

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

function createBot() {
  const config = loadConfig();
  const bot = new Telegraf(config.botToken || '');
  const userService = new UserService();
  const moderationService = new ModerationService();
  const database = new Database(config.databasePath);

  function isBotAdmin(ctx) {
    const userId = ctx.from?.id;
    if (!userId) {
      return false;
    }
    return database.isBotAdmin(ctx.chat.id, userId) || config.adminIds.includes(userId);
  }

  function ensureGroup(ctx) {
    database.ensureGroup(ctx.chat.id, ctx.chat.title || String(ctx.chat.id), ctx.chat?.owner_id || null);
  }

  bot.command(['start', 'начало'], (ctx) => {
    const isNew = userService.register(ctx.from.id);
    const status = isNew ? 'Рад знакомству' : 'С возвращением';
    ctx.reply(`${status}, ${ctx.from.first_name || 'пользователь'}!\n\nИспользуйте /help, чтобы увидеть команды.`);
  });

  bot.command(['help', 'помощь'], (ctx) => {
    ctx.reply([
      '📋 *СПРАВКА ПО КОМАНДАМ*',
      '',
      '👤 *ПОЛЬЗОВАТЕЛЬСКИЕ КОМАНДЫ*',
      '/start, /начало - начать работу',
      '/help, /помощь - показать эту справку',
      '/id, /айди - показать ваши ID',
      '/about, /информация - информация о боте',
      '/whoami, /кто_я - забавное описание вас',
      '',
      '👮 *МОДЕРСКИЕ КОМАНДЫ*',
      '/rules, /правила - показать правила чата',
      '/setrules, /установить_правила <текст> - установить правила',
      '/setgreeting, /установить_приветствие <текст> - установить приветствие',
      '/warn, /предупреждение - выдать предупреждение',
      '/warnings, /варны - показать варны пользователя',
      '/unwarn, /снять_предупреждение - снять предупреждения',
      '/mute, /мут <время> <причина> - ограничить сообщения',
      '/unmute, /размут - снять ограничение',
      '/ban, /бан <время> <причина> - заблокировать пользователя',
      '/unban, /разбан - разблокировать пользователя',
      '/addbotadmin, /добавить_админа - назначить админа бота (ответом на сообщение)',
      '/stats, /статистика - статистика пользователей',
      '',
      '🎉 *РАЗВЛЕЧЕНИЯ*',
      '/whoami, /кто_я - узнать, кто ты',
      '',
      '_Используйте русские или английские версии команд_',
    ].join('\n'), { parse_mode: 'Markdown' });
  });

  bot.command(['id', 'айди'], (ctx) => {
    ctx.reply(`Ваш Telegram ID: ${ctx.from.id}\nID чата: ${ctx.chat.id}`);
  });

  bot.command(['about', 'информация'], (ctx) => {
    ctx.reply(`${config.botName}\nПолноценный бот на Node.js.`);
  });

  bot.command(['whoami', 'кто_я'], (ctx) => {
    ctx.reply(`${ctx.from.first_name || 'Пользователь'}, ${getFunnyDescription()}`);
  });

  bot.command(['stats', 'статистика'], (ctx) => {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Команда доступна только администраторам.');
      return;
    }
    ctx.reply(`Зарегистрировано пользователей: ${userService.count}`);
  });

  bot.command(['rules', 'правила'], (ctx) => {
    ctx.reply(moderationService.getRules(ctx.chat.id));
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

  bot.command(['warn', 'предупреждение'], (ctx) => {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    const target = ctx.message.reply_to_message?.from || ctx.from;
    const details = parsePunishmentDetails(ctx.message.text.replace(/^\/warn\s*/i, ''), Boolean(ctx.message.reply_to_message));
    moderationService.addWarning(ctx.chat.id, target.id);
    database.addPunishment(ctx.chat.id, target.id, 'warn', details.reason, null);
    ctx.reply(`Предупреждение для ${target.first_name || target.username || target.id}: ${moderationService.getWarnings(ctx.chat.id, target.id)}/3. Причина: ${details.reason}`);
  });

  bot.command(['warnings', 'варны'], (ctx) => {
    ensureGroup(ctx);
    const target = ctx.message.reply_to_message?.from || ctx.from;
    ctx.reply(`Предупреждений: ${moderationService.getWarnings(ctx.chat.id, target.id)}/3`);
  });

  bot.command(['unwarn', 'снять_предупреждение'], (ctx) => {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    const target = ctx.message.reply_to_message?.from || ctx.from;
    moderationService.resetWarnings(ctx.chat.id, target.id);
    ctx.reply(`Предупреждения пользователя ${target.first_name || target.username || target.id} сброшены.`);
  });

  bot.command(['mute', 'мут'], (ctx) => {

    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    const target = ctx.message.reply_to_message?.from || ctx.from;
    const details = parsePunishmentDetails(ctx.message.text.replace(/^\/mute\s*/i, ''), Boolean(ctx.message.reply_to_message));
    database.addPunishment(ctx.chat.id, target.id, 'mute', details.reason, null);
    ctx.reply(`Пользователь ${target.first_name || target.username || target.id} ограничен. Причина: ${details.reason}`);
  });

  bot.command(['unmute', 'размут'], (ctx) => {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    const target = ctx.message.reply_to_message?.from || ctx.from;
    ctx.reply(`Ограничения с пользователя ${target.first_name || target.username || target.id} сняты.`);
  });

  bot.command(['ban', 'бан'], (ctx) => {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    const target = ctx.message.reply_to_message?.from || ctx.from;
    const details = parsePunishmentDetails(ctx.message.text.replace(/^\/ban\s*/i, ''), Boolean(ctx.message.reply_to_message));
    database.addPunishment(ctx.chat.id, target.id, 'ban', details.reason, null);
    ctx.reply(`Пользователь ${target.first_name || target.username || target.id} заблокирован. Причина: ${details.reason}`);
  });

  bot.command(['unban', 'разбан'], (ctx) => {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    const target = ctx.message.reply_to_message?.from || ctx.from;
    ctx.reply(`Пользователь ${target.first_name || target.username || target.id} разблокирован.`);
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

  bot.on('text', (ctx) => {
    if (!ctx.message.text || ctx.message.text.startsWith('/')) {
      return;
    }

    const text = ctx.message.text.trim();

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

    // Обработка фильтров
    const response = moderationService.findFilterResponse(ctx.chat.id, text);
    if (response) {
      ctx.reply(response);
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

module.exports = { createBot, parsePunishmentDetails, startBot };
