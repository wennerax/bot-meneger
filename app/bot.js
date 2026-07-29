const { Telegraf } = require('telegraf');
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

  function isGroupChat(ctx) {
    const type = ctx.chat?.type;
    return type === 'group' || type === 'supergroup';
  }

  function ensureGroup(ctx) {
    database.ensureGroup(ctx.chat.id, ctx.chat.title || String(ctx.chat.id), ctx.chat?.owner_id || null);
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
      '/whoami, !кто_я - забавное описание вас',
      '',
      '👮 МОДЕРСКИЕ КОМАНДЫ',
      '/rules, !правила - показать правила чата',
      '/setrules, !установить_правила <текст> - установить правила',
      '/setgreeting, !установить_приветствие <текст> - установить приветствие',
      '/warn, !предупреждение - выдать предупреждение',
      '/warnings, !варны - показать варны пользователя',
      '/unwarn, !снять_предупреждение - снять предупреждения',
      '/mute, !мут <время> <причина> - ограничить сообщения',
      '/unmute, !размут - снять ограничение',
      '/ban, !бан <время> <причина> - заблокировать пользователя',
      '/unban, !разбан - разблокировать пользователя',
      '/addbotadmin, !добавить_админа - назначить админа бота (ответом на сообщение)',
      '/stats, !статистика - статистика пользователей',
      '/top, !топ - топ пользователей по сообщениям в группе',
      '',
      '🎉 РАЗВЛЕЧЕНИЯ',
      '/hug @username, !обнять @username - обнять пользователя',
      '/kiss @username, !поцеловать @username - поцеловать пользователя',
      '/slap @username, !шлепнуть @username - шлёпнуть пользователя',
      '/poke @username, !тыкнуть @username - ткнуть пользователя',
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
      default:
        ctx.reply('Неизвестное действие.');
        break;
    }
  }

  async function resolveRoleplayTarget(ctx, args, usage) {
    const targetData = await resolveCommandTarget(ctx, args, usage);
    return targetData?.target || null;
  }

  function statsCommand(ctx) {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Команда доступна только администраторам.');
      return;
    }
    ctx.reply(`Зарегистрировано пользователей: ${userService.count}`);
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

  async function unwarnCommand(ctx) {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, '', '/unwarn @username');
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
    const untilDate = details.durationHours ? Math.floor(Date.now() / 1000) + Math.round(details.durationHours * 3600) : null;

    try {
      await ctx.telegram.restrictChatMember(ctx.chat.id, targetData.target.id, {
        can_send_messages: false,
        can_send_media_messages: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
        can_change_info: false,
        can_invite_users: false,
        can_pin_messages: false,
        can_manage_topics: false,
      }, untilDate);
    } catch (error) {
      ctx.reply('Не удалось применить mute: у бота нет прав администратора или запрет не поддерживается в этом чате.');
      return;
    }

    database.addPunishment(ctx.chat.id, targetData.target.id, 'mute', details.reason, untilDate);
    ctx.reply(`Пользователь ${targetData.target.first_name || targetData.target.username || targetData.target.id} ограничен. Причина: ${details.reason}`);
  }

  async function unmuteCommand(ctx) {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, '', '/unmute @username');
    if (!targetData) {
      return;
    }

    try {
      await ctx.telegram.restrictChatMember(ctx.chat.id, targetData.target.id, {
        can_send_messages: true,
        can_send_media_messages: true,
        can_send_polls: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true,
        can_change_info: false,
        can_invite_users: false,
        can_pin_messages: false,
        can_manage_topics: false,
      });
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
    const untilDate = details.durationHours ? Math.floor(Date.now() / 1000) + Math.round(details.durationHours * 3600) : null;

    try {
      await ctx.telegram.banChatMember(ctx.chat.id, targetData.target.id, untilDate);
    } catch (error) {
      ctx.reply('Не удалось выполнить ban: у бота нет прав администратора или пользователь не может быть заблокирован.');
      return;
    }

    database.addPunishment(ctx.chat.id, targetData.target.id, 'ban', details.reason, untilDate);
    ctx.reply(`Пользователь ${targetData.target.first_name || targetData.target.username || targetData.target.id} заблокирован. Причина: ${details.reason}`);
  }

  async function unbanCommand(ctx) {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, '', '/unban @username');
    if (!targetData) {
      return;
    }

    try {
      await ctx.telegram.unbanChatMember(ctx.chat.id, targetData.target.id, true);
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

    switch (command) {
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
      case 'кто_я':
        whoamiCommand(ctx);
        return true;
      case 'статистика':
        statsCommand(ctx);
        return true;
      case 'правила':
        rulesCommand(ctx);
        return true;
      case 'установить_правила':
        setRulesCommand(ctx, args);
        return true;
      case 'предупреждение':
        await warnCommand(ctx, args);
        return true;
      case 'варны':
        warningsCommand(ctx);
        return true;
      case 'снять_предупреждение':
        await unwarnCommand(ctx);
        return true;
      case 'мут':
        await muteCommand(ctx, args);
        return true;
      case 'размут':
        await unmuteCommand(ctx);
        return true;
      case 'бан':
        await banCommand(ctx, args);
        return true;
      case 'разбан':
        await unbanCommand(ctx);
        return true;
      case 'установить_приветствие':
        setGreetingCommand(ctx, args);
        return true;
      case 'добавить_админа':
        addBotAdminCommand(ctx);
        return true;
      case 'топ':
        topCommand(ctx);
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

  bot.command(['top', 'топ'], topCommand);

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
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, ctx.message.text.replace(/^\/warn\s*/i, ''), '/warn @username причина');
    if (!targetData) {
      return;
    }

    const details = parsePunishmentDetails(targetData.remainingArgs, Boolean(ctx.message.reply_to_message));
    moderationService.addWarning(ctx.chat.id, targetData.target.id);
    database.addPunishment(ctx.chat.id, targetData.target.id, 'warn', details.reason, null);
    ctx.reply(`Предупреждение для ${targetData.target.first_name || targetData.target.username || targetData.target.id}: ${moderationService.getWarnings(ctx.chat.id, targetData.target.id)}/3. Причина: ${details.reason}`);
  });

  bot.command(['warnings', 'варны'], (ctx) => {
    ensureGroup(ctx);
    const target = ctx.message.reply_to_message?.from || ctx.from;
    ctx.reply(`Предупреждений: ${moderationService.getWarnings(ctx.chat.id, target.id)}/3`);
  });

  bot.command(['unwarn', 'снять_предупреждение'], async (ctx) => {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, ctx.message.text.replace(/^\/unwarn\s*/i, ''), '/unwarn @username');
    if (!targetData) {
      return;
    }

    moderationService.resetWarnings(ctx.chat.id, targetData.target.id);
    ctx.reply(`Предупреждения пользователя ${targetData.target.first_name || targetData.target.username || targetData.target.id} сброшены.`);
  });

  bot.command(['mute', 'мут'], async (ctx) => {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, ctx.message.text.replace(/^\/mute\s*/i, ''), '/mute @username <время> <причина>');
    if (!targetData) {
      return;
    }

    const details = parsePunishmentDetails(targetData.remainingArgs, Boolean(ctx.message.reply_to_message));
    database.addPunishment(ctx.chat.id, targetData.target.id, 'mute', details.reason, null);
    ctx.reply(`Пользователь ${targetData.target.first_name || targetData.target.username || targetData.target.id} ограничен. Причина: ${details.reason}`);
  });

  bot.command(['unmute', 'размут'], async (ctx) => {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, ctx.message.text.replace(/^\/unmute\s*/i, ''), '/unmute @username');
    if (!targetData) {
      return;
    }

    ctx.reply(`Ограничения с пользователя ${targetData.target.first_name || targetData.target.username || targetData.target.id} сняты.`);
  });

  bot.command(['ban', 'бан'], async (ctx) => {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, ctx.message.text.replace(/^\/ban\s*/i, ''), '/ban @username <время> <причина>');
    if (!targetData) {
      return;
    }

    const details = parsePunishmentDetails(targetData.remainingArgs, Boolean(ctx.message.reply_to_message));
    database.addPunishment(ctx.chat.id, targetData.target.id, 'ban', details.reason, null);
    ctx.reply(`Пользователь ${targetData.target.first_name || targetData.target.username || targetData.target.id} заблокирован. Причина: ${details.reason}`);
  });

  bot.command(['unban', 'разбан'], async (ctx) => {
    ensureGroup(ctx);
    if (!isBotAdmin(ctx)) {
      ctx.reply('Эта команда доступна только администраторам.');
      return;
    }

    const targetData = await resolveCommandTarget(ctx, ctx.message.text.replace(/^\/unban\s*/i, ''), '/unban @username');
    if (!targetData) {
      return;
    }

    ctx.reply(`Пользователь ${targetData.target.first_name || targetData.target.username || targetData.target.id} разблокирован.`);
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
    }

    if (text.startsWith('/')) {
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
