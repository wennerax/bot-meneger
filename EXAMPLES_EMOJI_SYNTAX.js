/**
 * Примеры использования emoji:id() синтаксиса для кастомных эмодзи
 * 
 * Формат: emoji:id(TELEGRAM_ID)
 * 
 * Пример: "Люблю emoji:id(5328145443106873128)"
 * 
 * Преимущества:
 * - Простой синтаксис - пишешь прямо в строке
 * - Никаких плейсхолдеров - не нужно готовить маппинг
 * - Автоматический fallback для обычных пользователей
 * - Легко добавить множество эмодзи подряд
 */

const { Telegraf } = require('telegraf');
const { sendWithEmojiSyntax, parseEmojiSyntax } = require('./app/premium_emojis');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ============================================================
// ПРИМЕР 1: Простое использование в сообщении
// ============================================================

bot.command('love', async (ctx) => {
  // Отправить сообщение с кастомным эмодзи в тексте
  await sendWithEmojiSyntax(
    ctx,
    'Люблю emoji:id(5328145443106873128) этот бот! emoji:id(5328151038599003814)'
  );
});

// ============================================================
// ПРИМЕР 2: Множество эмодзи в одном сообщении
// ============================================================

bot.command('multi', async (ctx) => {
  await sendWithEmojiSyntax(
    ctx,
    `Красивые эмодзи:
emoji:id(5328145443106873128) - Фиолетовое сердце
emoji:id(5312949421381177815) - Розовое сердце
emoji:id(5328151038599003814) - Горящее сердце`
  );
});

// ============================================================
// ПРИМЕР 3: В коллбеке
// ============================================================

bot.action('premium_flower', async (ctx) => {
  await sendWithEmojiSyntax(
    ctx,
    'Цветок: emoji:id(5312948834137047286) Красивый выбор!'
  );
});

// ============================================================
// ПРИМЕР 4: Комбинирование обычного текста и эмодзи
// ============================================================

bot.command('greeting', async (ctx) => {
  const username = ctx.from.first_name || 'друг';
  
  await sendWithEmojiSyntax(
    ctx,
    `Привет ${username}! emoji:id(5325885244695425655) 
Добро пожаловать в наш чат! emoji:id(5328146574935768874)`
  );
});

// ============================================================
// ПРИМЕР 5: Использование parseEmojiSyntax отдельно
// ============================================================

bot.command('parse', async (ctx) => {
  const textWithEmoji = 'Я люблю emoji:id(5328145443106873128) Telegram Premium!';
  const { text, entities } = parseEmojiSyntax(textWithEmoji);
  
  console.log('Исходный текст:', textWithEmoji);
  console.log('Обработанный текст:', text);
  console.log('Entities для Telegram API:', entities);
  
  // Отправить вручную с entities
  await ctx.reply(text, { entities });
});

// ============================================================
// ПРИМЕР 6: Сообщение с кнопками и эмодзи
// ============================================================

bot.command('menu', async (ctx) => {
  await sendWithEmojiSyntax(
    ctx,
    'Выбери действие emoji:id(5328146574935768874):',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'emoji:id(5312948834137047286) Цветок', callback_data: 'flower' }],
          [{ text: 'emoji:id(5325885244695425655) Кот', callback_data: 'cat' }],
          [{ text: 'emoji:id(5328145443106873128) Сердце', callback_data: 'heart' }],
        ],
      },
    }
  );
});

// ============================================================
// ПРИМЕР 7: Полная интеграция - приветствие нового пользователя
// ============================================================

bot.on('new_chat_members', async (ctx) => {
  const member = ctx.message.new_chat_members[0];
  
  await sendWithEmojiSyntax(
    ctx,
    `Добро пожаловать, ${member.first_name}! emoji:id(5325885244695425655)

В нашем чате:
emoji:id(5328145443106873128) - Можно писать что угодно
emoji:id(5328146574935768874) - Помогаем друг другу  
emoji:id(5312949421381177815) - Весело и дружно!

Приятного времяпровождения! emoji:id(5328147729537945974)`
  );
});

// ============================================================
// ПРИМЕР 8: Ответ на команду с форматированием
// ============================================================

bot.command('status', async (ctx) => {
  await sendWithEmojiSyntax(
    ctx,
    `emoji:id(5328146574935768874) *Статус Бота*

• emoji:id(5325885244695425655) Активен
• emoji:id(5328145443106873128) Все функции работают
• emoji:id(5312949421381177815) Обновлено

Спасибо за использование! emoji:id(5328147729537945974)`,
    { parse_mode: 'HTML' }
  );
});

// ============================================================
// ПРИМЕР 9: Регулярное уведомление с эмодзи
// ============================================================

async function sendDailyNotification(chatId) {
  const now = new Date();
  const hour = now.getHours();
  
  const greeting = hour < 12 
    ? 'Доброе утро emoji:id(5325885244695425655)!'
    : hour < 18
    ? 'Добрый день emoji:id(5328146574935768874)!'
    : 'Добрый вечер emoji:id(5328147729537945974)!';
  
  // Отправить прямо через telegram API
  const { text, entities } = parseEmojiSyntax(greeting);
  
  await bot.telegram.sendMessage(chatId, text, { 
    entities,
    parse_mode: 'HTML'
  });
}

// ============================================================
// ПРИМЕР 10: Чистое использование API парсера
// ============================================================

function demonstrateParser() {
  const examples = [
    'Люблю emoji:id(5328145443106873128)',
    'emoji:id(111) и emoji:id(222) и emoji:id(333)',
    'Текст emoji:id(12345) посередине emoji:id(67890) текста',
  ];
  
  examples.forEach((text) => {
    const result = parseEmojiSyntax(text);
    console.log('\nИсходный текст:', text);
    console.log('Обработано:', result.text);
    console.log('Entities:', result.entities);
  });
}

// Раскомментируй для демонстрации
// demonstrateParser();

// ============================================================
// КЛЮЧЕВЫЕ ФУНКЦИИ
// ============================================================

/**
 * sendWithEmojiSyntax(ctx, text, options)
 * 
 * Автоматически парсит текст и отправляет с entities
 * 
 * @param {Object} ctx - Telegraf контекст
 * @param {string} text - Текст с emoji:id(...) паттернами
 * @param {Object} options - Опции ctx.reply
 */

/**
 * parseEmojiSyntax(text)
 * 
 * Парсит текст и возвращает готовый результат
 * 
 * @param {string} text - Текст с emoji:id(...) паттернами
 * @returns {Object} { text: 'обработанный текст', entities: [...] }
 */

// ============================================================
// ДОСТУПНЫЕ ID ЭМОДЗИ
// ============================================================

const EMOJI_IDS_REFERENCE = {
  // Сердца
  'heart_purple': '5328145443106873128',
  'heart_pink': '5312949421381177815',
  'heart_fire': '5328151038599003814',
  
  // Цветы
  'flower_pink': '5312948834137047286',
  'flower_blue': '5312947055836119424',
  
  // Лица
  'cat_happy': '5325885244695425655',
  'angel': '5328147729537945974',
  
  // Звезды
  'star_purple': '5328146574935768874',
};

module.exports = {
  sendWithEmojiSyntax,
  parseEmojiSyntax,
  EMOJI_IDS_REFERENCE,
};
