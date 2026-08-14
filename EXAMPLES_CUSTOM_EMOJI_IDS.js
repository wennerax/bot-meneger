/**
 * Примеры использования кастомных ID эмодзи Telegram
 * 
 * Кастомные ID эмодзи - это премиум эмодзи которые показываются
 * пользователям с Telegram Premium подпиской.
 * 
 * Для старых версий Telegram автоматически показывается fallback эмодзи.
 */

// ==================== ИМПОРТ ====================
/*
const { 
  replyWithCustomEmoji,
  getCustomEmojiId,
  getCustomEmojiFallback,
  createCustomEmojiEntity,
  addCustomEmoji,
  getAllCustomEmojis,
} = require('./premium_emojis');
*/

// ==================== ПРИМЕР 1: Простой способ - через реплай ====================
/*
bot.command('love', async (ctx) => {
  // Отправить сообщение с кастомным эмодзи
  // {heart} будет заменен на фиолетовое сердце
  await replyWithCustomEmoji(
    ctx,
    'Я {heart} тебя!',
    { '{heart}': 'heart_purple' }
  );
});

// Результат:
// Для Premium пользователей: красивое фиолетовое сердце с эффектом
// Для обычных пользователей: фиолетовое сердце 💜
*/

// ==================== ПРИМЕР 2: Несколько кастомных эмодзи ====================
/*
bot.command('flowers', async (ctx) => {
  await replyWithCustomEmoji(
    ctx,
    'Красивые цветы! {pink_flower} {blue_flower}',
    {
      '{pink_flower}': 'flower_pink',
      '{blue_flower}': 'flower_blue',
    }
  );
});

// Результат: сообщение с двумя красивыми кастомными цветами
*/

// ==================== ПРИМЕР 3: В кнопках меню ====================
/*
async function sendCustomEmojiMenu(ctx, chatId) {
  const heartPurpleId = getCustomEmojiId('heart_purple');
  const angelId = getCustomEmojiId('angel');
  const starId = getCustomEmojiId('star_purple');
  
  const heartFallback = getCustomEmojiFallback('heart_purple');
  const angelFallback = getCustomEmojiFallback('angel');
  const starFallback = getCustomEmojiFallback('star_purple');

  // Для кнопок нужно использовать fallback и entities
  const entities = [
    createCustomEmojiEntity('heart_purple', 0),
    createCustomEmojiEntity('angel', 10),
    createCustomEmojiEntity('star_purple', 20),
  ];

  await ctx.reply(
    `${heartFallback} Любовь ${angelFallback} Ангел ${starFallback} Звезда`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { 
              text: `${heartFallback} Выбрать сердце`, 
              callback_data: 'emoji:heart_purple' 
            },
          ],
          [
            { 
              text: `${angelFallback} Выбрать ангела`, 
              callback_data: 'emoji:angel' 
            },
          ],
          [
            { 
              text: `${starFallback} Выбрать звезду`, 
              callback_data: 'emoji:star_purple' 
            },
          ],
        ],
      },
      entities: entities,
    }
  );
}

bot.command('menu', async (ctx) => {
  await sendCustomEmojiMenu(ctx, ctx.chat.id);
});
*/

// ==================== ПРИМЕР 4: Добавить новый кастомный эмодзи ====================
/*
const { addCustomEmoji } = require('./premium_emojis');

// Если у тебя есть новый ID эмодзи, добавь его:
addCustomEmoji(
  'cat_happy',           // имя (уникальный ключ)
  '5325885244695425655', // ID из Telegram
  '😸',                  // fallback эмодзи
  'Счастливый кот'       // описание (опционально)
);

// Теперь можешь использовать:
await replyWithCustomEmoji(ctx, 'Милый кот {cat}', { '{cat}': 'cat_happy' });
*/

// ==================== ПРИМЕР 5: Получить информацию об эмодзи ====================
/*
const { getCustomEmojiInfo, getAllCustomEmojis } = require('./premium_emojis');

// Получить одно эмодзи
const info = getCustomEmojiInfo('heart_purple');
console.log(info);
// { id: '5328145443106873128', fallback: '💜', displayName: 'Фиолетовое сердце' }

// Получить все эмодзи
const allEmojis = getAllCustomEmojis();
for (const [name, info] of Object.entries(allEmojis)) {
  console.log(`${name}: ${info.fallback} - ${info.id}`);
}
*/

// ==================== ПРИМЕР 6: Проверка наличия эмодзи ====================
/*
const { hasCustomEmoji } = require('./premium_emojis');

if (hasCustomEmoji('heart_purple')) {
  console.log('Эмодзи heart_purple есть в системе');
}
*/

// ==================== ПРИМЕР 7: Сложное сообщение с несколькими эмодзи ====================
/*
bot.command('special', async (ctx) => {
  const text = `
Спасибо за внимание! {heart}

Этот бот создан с {fire_heart} любовью {fire_heart}
и украшен {pink_flower} цветами {blue_flower}

Вы такой {angel} замечательный! {purple_star}
  `.trim();

  await replyWithCustomEmoji(
    ctx,
    text,
    {
      '{heart}': 'heart_purple',
      '{fire_heart}': 'heart_fire',
      '{pink_flower}': 'flower_pink',
      '{blue_flower}': 'flower_blue',
      '{angel}': 'angel',
      '{purple_star}': 'star_purple',
    },
    {
      parse_mode: 'HTML',
    }
  );
});

// Результат: красивое многоцветное сообщение с кастомными эмодзи
*/

// ==================== ПРИМЕР 8: В callback обработке ====================
/*
bot.action('emoji:heart_purple', async (ctx) => {
  await ctx.editMessageText(
    'Вы выбрали: {heart}',
    {
      reply_markup: undefined,
    }
  );
  
  // Использовать replyWithCustomEmoji
  await replyWithCustomEmoji(
    ctx,
    'Отлично! Ваше выбранное эмодзи: {heart}',
    { '{heart}': 'heart_purple' }
  );
});
*/

// ==================== ПРИМЕР 9: Условное использование эмодзи ====================
/*
async function sendLikeMessage(ctx, likes) {
  let message = `Лайков: ${likes} `;
  let emojiMap = {};

  if (likes > 0 && likes <= 10) {
    message += '{heart}';
    emojiMap['{heart}'] = 'heart_purple';
  } else if (likes > 10 && likes <= 50) {
    message += '{fire_heart}';
    emojiMap['{fire_heart}'] = 'heart_fire';
  } else if (likes > 50) {
    message += '{fire_heart} {fire_heart} {fire_heart}';
    emojiMap['{fire_heart}'] = 'heart_fire';
  }

  await replyWithCustomEmoji(ctx, message, emojiMap);
}

// Использование
await sendLikeMessage(ctx, 100); // 3 горящих сердца
*/

// ==================== ПРИМЕР 10: Лучшие практики ====================
/*
// ✅ ПРАВИЛЬНО: Использовать replyWithCustomEmoji
await replyWithCustomEmoji(
  ctx,
  'Сообщение {heart}',
  { '{heart}': 'heart_purple' }
);

// ✅ ПРАВИЛЬНО: Проверить наличие эмодзи перед использованием
if (hasCustomEmoji('cat_happy')) {
  await replyWithCustomEmoji(ctx, 'Кот {cat}', { '{cat}': 'cat_happy' });
}

// ✅ ПРАВИЛЬНО: Использовать fallback для кнопок
const fallback = getCustomEmojiFallback('heart_purple');
button.text = `${fallback} Выбрать`;

// ❌ НЕ ПРАВИЛЬНО: Не пытайся использовать ID напрямую в тексте
// await ctx.reply('5328145443106873128'); // Это не сработает

// ❌ НЕ ПРАВИЛЬНО: Не смешивай кастомные эмодзи с обычным текстом без структуры
// await ctx.reply('Текст 5328145443106873128 текст'); // Так не работает
*/

// ==================== ПОЛЕЗНЫЕ ССЫЛКИ ====================
/*
// Как получить ID кастомных эмодзи:
// 1. Telegram Desktop - Наведи на эмодзи, скопируй ID
// 2. Telegram Bot API - Используй getCustomEmojiStickers
// 3. Telegram документация - https://core.telegram.org/bots/api#customemoji

// Где найти Premium эмодзи паки:
// Telegram → Emoji → Premium раздел
// Там ты можешь найти и скопировать ID интересующих эмодзи
*/

module.exports = {
  description: 'Примеры использования кастомных ID эмодзи'
};
