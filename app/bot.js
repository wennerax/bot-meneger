const { Telegraf } = require('telegraf');
const { loadConfig } = require('./config');
const UserService = require('./services/user_service');
const ModerationService = require('./services/moderation_service');
const Database = require('./services/database');

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

  bot.start((ctx) => {
    const isNew = userService.register(ctx.from.id);
    const status = isNew ? 'Рад знакомству' : 'С возвращением';
    ctx.reply(`${status}, ${ctx.from.first_name || 'пользователь'}!\n\nИспользуйте /help, чтобы увидеть команды.`);
  });

  bot.command('help', (ctx) => {
    ctx.reply([
      'Доступные команды:',
      '/start - начать работу',
      '/help - показать эту справку',
      '/id - показать ваши ID',
      '/about - информация о боте',
      '/stats - статистика для администратора',
      '/rules - показать правила чата',
      '/warn - предупреждение',
      '/mute - ограничение сообщений',
      '/ban - блокировка пользователя',
    ].join('\n'));
  });

  bot.command('id', (ctx) => {
    ctx.reply(`Ваш Telegram ID: ${ctx.from.id}\nID чата: ${ctx.chat.id}`);
  });

  bot.command('about', (ctx) => {
    ctx.reply(`${config.botName}\nПолноценный бот на Node.js.`);
  });

  bot.command('stats', (ctx) => {
    if (!config.adminIds.includes(ctx.from.id)) {
      ctx.reply('Команда доступна только администраторам.');
      return;
    }
    ctx.reply(`Зарегистрировано пользователей: ${userService.count}`);
  });

  bot.command('rules', (ctx) => {
    ctx.reply(moderationService.getRules(ctx.chat.id));
  });

  bot.command('setrules', (ctx) => {
    if (!config.adminIds.includes(ctx.from.id)) {
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

  bot.command('warn', (ctx) => {
    if (!config.adminIds.includes(ctx.from.id)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    const target = ctx.message.reply_to_message?.from || ctx.from;
    const details = parsePunishmentDetails(ctx.message.text.replace(/^\/warn\s*/i, ''), Boolean(ctx.message.reply_to_message));
    moderationService.addWarning(ctx.chat.id, target.id);
    database.addPunishment(ctx.chat.id, target.id, 'warn', details.reason, null);
    ctx.reply(`Предупреждение для ${target.first_name || target.username || target.id}: ${moderationService.getWarnings(ctx.chat.id, target.id)}/3. Причина: ${details.reason}`);
  });

  bot.command('mute', (ctx) => {
    if (!config.adminIds.includes(ctx.from.id)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    const target = ctx.message.reply_to_message?.from || ctx.from;
    const details = parsePunishmentDetails(ctx.message.text.replace(/^\/mute\s*/i, ''), Boolean(ctx.message.reply_to_message));
    database.addPunishment(ctx.chat.id, target.id, 'mute', details.reason, null);
    ctx.reply(`Пользователь ${target.first_name || target.username || target.id} ограничен. Причина: ${details.reason}`);
  });

  bot.command('ban', (ctx) => {
    if (!config.adminIds.includes(ctx.from.id)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }
    const target = ctx.message.reply_to_message?.from || ctx.from;
    const details = parsePunishmentDetails(ctx.message.text.replace(/^\/ban\s*/i, ''), Boolean(ctx.message.reply_to_message));
    database.addPunishment(ctx.chat.id, target.id, 'ban', details.reason, null);
    ctx.reply(`Пользователь ${target.first_name || target.username || target.id} заблокирован. Причина: ${details.reason}`);
  });

  bot.on('text', (ctx) => {
    if (!ctx.message.text || ctx.message.text.startsWith('/')) {
      return;
    }

    const response = moderationService.findFilterResponse(ctx.chat.id, ctx.message.text);
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
