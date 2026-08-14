/**
 * Примеры интеграции системы премиум эмодзи в bot.js
 * 
 * Копируйте эти примеры в ваш bot.js и адаптируйте под свои нужды
 */

// ==================== ИМПОРТ ====================
// Добавить в начало bot.js после других импортов:
/*
const { 
  replacePremiumEmojis, 
  getPremiumEmoji, 
  EMOJI_NAMES,
  createCustomEmojiMap 
} = require('./premium_emojis');
*/

// ==================== ПРИМЕР 1: В главном меню ====================
/*
function buildSettingsMainKeyboard(chatId) {
  return {
    inline_keyboard: [
      [
        { 
          text: `${getPremiumEmoji('puzzle')} Капча`, 
          callback_data: `settings:section:captcha:${chatId}` 
        },
        { 
          text: `${getPremiumEmoji('link')} Ссылки`, 
          callback_data: `settings:section:links:${chatId}` 
        },
      ],
      [
        { 
          text: `${getPremiumEmoji('shield')} Антиспам`, 
          callback_data: `settings:section:anti:${chatId}` 
        },
        { 
          text: `${getPremiumEmoji('puzzle')} Правила`, 
          callback_data: `settings:section:rules:${chatId}` 
        },
      ],
      [
        { 
          text: `${getPremiumEmoji('ban')} Банворды`, 
          callback_data: `settings:section:banwords:${chatId}` 
        },
        { 
          text: `${getPremiumEmoji('warning')} Варны`, 
          callback_data: `settings:section:warns:${chatId}` 
        },
      ],
      [
        { 
          text: `${getPremiumEmoji('settings')} Команды`, 
          callback_data: `settings:section:commands:${chatId}` 
        },
        { 
          text: `${getPremiumEmoji('robot')} Медиа ИИ`, 
          callback_data: `settings:section:media_ai:${chatId}` 
        },
      ],
      [
        { 
          text: `${getPremiumEmoji('chat')} Первый комментарий`, 
          callback_data: `settings:section:first_comment:${chatId}` 
        },
        { 
          text: `${getPremiumEmoji('megaphone')} @admin`, 
          callback_data: `settings:section:admin_notify:${chatId}` 
        },
      ],
      [
        { 
          text: `${getPremiumEmoji('sparkles')} Скрытые пользователи`, 
          callback_data: `settings:section:anonymous:${chatId}` 
        },
      ],
      [
        { 
          text: `${getPremiumEmoji('cross')} Закрыть`, 
          callback_data: 'settings:close' 
        },
      ],
    ],
  };
}
*/

// ==================== ПРИМЕР 2: В сообщениях команд ====================
/*
// /warn команда
bot.command('warn', async (ctx) => {
  // Старый способ:
  // await replyWithAutoDelete(ctx, '⚠️ Вам выдано предупреждение!', {}, 5000);
  
  // Новый способ с премиум эмодзи:
  await replyWithAutoDelete(
    ctx, 
    replacePremiumEmojis(`${getPremiumEmoji('warning')} Вам выдано предупреждение!\n${getPremiumEmoji('fire')} Будьте осторожны!`),
    {},
    5000
  );
});

// /ban команда
bot.command('ban', async (ctx) => {
  await replyWithAutoDelete(
    ctx,
    replacePremiumEmojis(`${getPremiumEmoji('ban')} Вы забанены!\n${getPremiumEmoji('shield')} Решение модератора.`),
    {},
    5000
  );
});

// /mute команда
bot.command('mute', async (ctx) => {
  await replyWithAutoDelete(
    ctx,
    replacePremiumEmojis(`${getPremiumEmoji('speaker')} Вы заглушены на время.\n${getPremiumEmoji('warning')} Соблюдайте правила!`),
    {},
    5000
  );
});

// /unban команда
bot.command('unban', async (ctx) => {
  await replyWithAutoDelete(
    ctx,
    replacePremiumEmojis(`${getPremiumEmoji('check')} Вы разбанены!\n${getPremiumEmoji('heart')} Добро пожаловать обратно!`),
    {},
    5000
  );
});
*/

// ==================== ПРИМЕР 3: Сообщения с ошибками и предупреждениями ====================
/*
async function sendErrorMessage(ctx, error) {
  await replyWithAutoDelete(
    ctx,
    replacePremiumEmojis(`${getPremiumEmoji('cross')} Ошибка!\n${error}`),
    {},
    5000
  );
}

async function sendWarningMessage(ctx, warning) {
  await replyWithAutoDelete(
    ctx,
    replacePremiumEmojis(`${getPremiumEmoji('warning')} Внимание!\n${warning}`),
    {},
    5000
  );
}

async function sendSuccessMessage(ctx, message) {
  await replyWithAutoDelete(
    ctx,
    replacePremiumEmojis(`${getPremiumEmoji('check')} Успешно!\n${message}`),
    {},
    5000
  );
}

async function sendInfoMessage(ctx, message) {
  await replyWithAutoDelete(
    ctx,
    replacePremiumEmojis(`${getPremiumEmoji('info')} Информация\n${message}`),
    {}
  );
}
*/

// ==================== ПРИМЕР 4: Кнопки с динамическими эмодзи ====================
/*
function buildLikeDislikeButtons() {
  return {
    inline_keyboard: [
      [
        { 
          text: `${getPremiumEmoji('like')} Хорошо`, 
          callback_data: 'rating:good' 
        },
        { 
          text: `${getPremiumEmoji('dislike')} Плохо`, 
          callback_data: 'rating:bad' 
        },
      ],
    ],
  };
}

function buildYesNoButtons() {
  return {
    inline_keyboard: [
      [
        { 
          text: `${getPremiumEmoji('check')} Да`, 
          callback_data: 'confirm:yes' 
        },
        { 
          text: `${getPremiumEmoji('cross')} Нет`, 
          callback_data: 'confirm:no' 
        },
      ],
    ],
  };
}

function buildHelpButtons() {
  return {
    inline_keyboard: [
      [
        { 
          text: `${getPremiumEmoji('question')} Помощь`, 
          callback_data: 'help' 
        },
        { 
          text: `${getPremiumEmoji('settings')} Настройки`, 
          callback_data: 'settings' 
        },
      ],
      [
        { 
          text: `${getPremiumEmoji('info')} Информация`, 
          callback_data: 'info' 
        },
      ],
    ],
  };
}
*/

// ==================== ПРИМЕР 5: Помощь и информационные сообщения ====================
/*
bot.command('help', async (ctx) => {
  await ctx.reply(replacePremiumEmojis(`
${getPremiumEmoji('info')} Справка по командам:

${getPremiumEmoji('settings')} /settings - Настройки бота
${getPremiumEmoji('warning')} /warn - Выдать предупреждение
${getPremiumEmoji('ban')} /ban - Забанить пользователя
${getPremiumEmoji('speaker')} /mute - Заглушить пользователя
${getPremiumEmoji('check')} /unban - Разбанить пользователя
${getPremiumEmoji('info')} /info - Информация

${getPremiumEmoji('fire')} Создано с ${getPremiumEmoji('fire_heart')}
  `), buildHelpButtons());
});

bot.command('start', async (ctx) => {
  await ctx.reply(replacePremiumEmojis(`
${getPremiumEmoji('party')} Добро пожаловать!

${getPremiumEmoji('rocket')} Я бот для модерации группы
${getPremiumEmoji('shield')} Защищу от спама и вредоносного контента
${getPremiumEmoji('sparkles')} Улучшу опыт пользователей

${getPremiumEmoji('gear')} Используйте /settings для настройки
${getPremiumEmoji('question')} Или /help для справки
  `));
});
*/

// ==================== ПРИМЕР 6: Меню управления предупреждениями ====================
/*
function buildSettingsWarnsMenuText(chatId) {
  const service = activeModerationService || defaultModerationService;
  const maxWarns = service.getMaxWarnings(chatId);
  const duration = service.getWarnBlockDuration(chatId);
  
  const durationText = duration === 0 ? 'Навсегда' : `${duration}ч`;
  
  return replacePremiumEmojis(`
${getPremiumEmoji('warning')} Управление предупреждениями

${getPremiumEmoji('info')} Максимум предупреждений: ${maxWarns}
${getPremiumEmoji('info')} Длительность бана: ${durationText}

${getPremiumEmoji('settings')} Выберите действие:
  `);
}

function buildSettingsWarnsMenuKeyboard(chatId) {
  return {
    inline_keyboard: [
      [
        { 
          text: `${getPremiumEmoji('warning')} Установить лимит`, 
          callback_data: `settings:warn_limit_menu:${chatId}` 
        },
      ],
      [
        { 
          text: `${getPremiumEmoji('clock')} Установить длительность`, 
          callback_data: `settings:warn_duration:${chatId}` 
        },
      ],
      [
        { 
          text: `${getPremiumEmoji('back')} Назад`, 
          callback_data: `settings:main:${chatId}` 
        },
      ],
    ],
  };
}
*/

// ==================== ПРИМЕР 7: Кастомный маппинг для конкретных команд ====================
/*
// Если вы хотите использовать свои эмодзи в определенном месте
const customBotEmojis = createCustomEmojiMap({
  '❤️': '💖✨',       // Добавить сияние к сердцу
  '🔥': '🌟💥',       // Изменить огонь на звезду
  '✅': '☑️👍',       // Комбинировать эмодзи
});

// Использовать в конкретном сообщении:
await ctx.reply(replacePremiumEmojis('Спасибо ❤️ за вашу помощь! ✅', customBotEmojis));
*/

// ==================== ПРИМЕР 8: Статус и прогресс ====================
/*
async function showProgress(ctx, current, total, message = '') {
  const percent = Math.floor((current / total) * 100);
  const filled = Math.floor(percent / 10);
  const empty = 10 - filled;
  
  const bar = getPremiumEmoji('fire').repeat(filled) + '░'.repeat(empty);
  
  await ctx.reply(replacePremiumEmojis(`
${message}
${bar} ${percent}%

${getPremiumEmoji('info')} ${current}/${total} завершено
  `));
}

// Использование:
showProgress(ctx, 5, 10, 'Обработка данных...');
// Результат: 🔥🔥░░░░░░░░ 50%
*/

// ==================== ПРИМЕР 9: Список действий ====================
/*
bot.command('actions', async (ctx) => {
  await ctx.reply(replacePremiumEmojis(`
${getPremiumEmoji('list')} Доступные действия:

${getPremiumEmoji('ban')} Блокировка пользователя
${getPremiumEmoji('warning')} Выдача предупреждений
${getPremiumEmoji('speaker')} Заглушение
${getPremiumEmoji('megaphone')} Уведомление в чат
${getPremiumEmoji('settings')} Изменение настроек
${getPremiumEmoji('shield')} Защита от спама
${getPremiumEmoji('link')} Управление ссылками

${getPremiumEmoji('fire')} Все действия логируются ${getPremiumEmoji('fire_heart')}
  `), 
  {
    reply_markup: {
      inline_keyboard: [
        [{ text: `${getPremiumEmoji('back')} Назад`, callback_data: 'back' }]
      ]
    }
  });
});
*/

// ==================== ПРИМЕР 10: Правила использования ====================
/*
const RULES_TEXT = replacePremiumEmojis(`
${getPremiumEmoji('shield')} ПРАВИЛА ГРУППЫ

1. ${getPremiumEmoji('ban')} Запрещен спам и реклама
2. ${getPremiumEmoji('ban')} Запрещены оскорбления
3. ${getPremiumEmoji('ban')} Запрещены порнографические материалы
4. ${getPremiumEmoji('link')} Разрешены только одобренные ссылки
5. ${getPremiumEmoji('speaker')} Соблюдайте тишину после 22:00

${getPremiumEmoji('warning')} За нарушения выдаются предупреждения
${getPremiumEmoji('fire')} После 3 предупреждений - бан!

${getPremiumEmoji('check')} Спасибо за понимание ${getPremiumEmoji('heart')}
`);

bot.command('rules', async (ctx) => {
  await ctx.reply(RULES_TEXT);
});
*/

module.exports = {
  // Экспортируем примеры если нужны
  description: 'Примеры использования системы премиум эмодзи'
};
