# 🎨 Премиум Эмодзи - Быстрый Старт

## Что это?

Система для использования премиум эмодзи Telegram вместо обычных. Премиум эмодзи отображаются с красивой анимацией для пользователей с подписанным Telegram Premium.

## 3 способа использования

### 1️⃣ Самый быстрый - замена в тексте

```javascript
const { replacePremiumEmojis } = require('./app/premium_emojis');

// Просто замените эмодзи в любой строке
await ctx.reply(replacePremiumEmojis('Спасибо ❤️ за помощь! 👍'));
// Результат: 'Спасибо ❤️‍🔥 за помощь! 👍'
```

### 2️⃣ Удобный - использование по имени

```javascript
const { getPremiumEmoji } = require('./app/premium_emojis');

// Получить эмодзи по красивому имени
const like = getPremiumEmoji('like');           // 👍
const check = getPremiumEmoji('check');         // ✅
const fire = getPremiumEmoji('fire');           // 🔥
const heart = getPremiumEmoji('heart');         // ❤️

// Использовать в сообщениях
await ctx.reply(`${getPremiumEmoji('check')} Готово!`);

// Использовать в кнопках
{
  text: `${getPremiumEmoji('like')} Лайк`,
  callback_data: 'like'
}
```

### 3️⃣ Мощный - кастомный маппинг

```javascript
const { replacePremiumEmojis, createCustomEmojiMap } = require('./app/premium_emojis');

// Создать свой маппинг для конкретного места
const customEmojis = createCustomEmojiMap({
  '❤️': '💖✨',    // Добавить спецэффект
  '🔥': '🌟💥',    // Изменить вид
});

// Использовать только для этого сообщения
await ctx.reply(replacePremiumEmojis('Люблю ❤️ это! 🔥', customEmojis));
```

## 📌 Все доступные эмодзи по имени

| Имя | Эмодзи | Имя | Эмодзи |
|-----|--------|-----|--------|
| `like` | 👍 | `check` | ✅ |
| `fire` | 🔥 | `heart` | ❤️ |
| `fire_heart` | ❤️‍🔥 | `party` | 🎉 |
| `warning` | ⚠️ | `sparkles` | ✨ |
| `laugh` | 😂 | `cool` | 😎 |
| `happy` | 😊 | `shocked` | 😱 |
| `trophy` | 🏆 | `star` | ⭐ |
| `gift` | 🎁 | `shield` | 🛡️ |
| `settings` | ⚙️ | `ban` | 🚫 |
| `cross` | ❌ | `megaphone` | 📣 |
| `chat` | 💬 | `link` | 🔗 |
| `unlock` | 🔓 | `lock` | 🔒 |

[Полный список](./PREMIUM_EMOJIS_GUIDE.md#-все-доступные-эмодзи-по-имени-emoji_names)

## 🚀 Примеры для копирования

### В главном меню:
```javascript
function buildSettingsMainKeyboard(chatId) {
  const { getPremiumEmoji } = require('./app/premium_emojis');
  
  return {
    inline_keyboard: [
      [
        { 
          text: `${getPremiumEmoji('shield')} Антиспам`, 
          callback_data: `settings:section:anti:${chatId}` 
        },
        { 
          text: `${getPremiumEmoji('warning')} Варны`, 
          callback_data: `settings:section:warns:${chatId}` 
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
```

### В сообщениях команд:
```javascript
const { getPremiumEmoji, replacePremiumEmojis } = require('./app/premium_emojis');

bot.command('warn', async (ctx) => {
  await ctx.reply(replacePremiumEmojis(`
${getPremiumEmoji('warning')} Вам выдано предупреждение!
${getPremiumEmoji('fire')} Соблюдайте правила!
  `));
});

bot.command('help', async (ctx) => {
  await ctx.reply(replacePremiumEmojis(`
${getPremiumEmoji('info')} Справка:

${getPremiumEmoji('settings')} /settings - Настройки
${getPremiumEmoji('ban')} /ban - Забанить
${getPremiumEmoji('warning')} /warn - Предупредить

${getPremiumEmoji('heart')} Спасибо за использование! ${getPremiumEmoji('fire_heart')}
  `));
});
```

## 📚 Файлы системы

- **`app/premium_emojis.js`** - основной модуль (маппинг, функции)
- **`PREMIUM_EMOJIS_GUIDE.md`** - полная документация со всеми примерами
- **`EXAMPLES_PREMIUM_EMOJIS.js`** - примеры для копирования в bot.js
- **`tests/premium_emojis.test.js`** - тесты (97/97 passing ✅)

## ❓ Частые вопросы

**Q: Будут ли эмодзи отображаться красиво?**  
A: Да, для пользователей с Telegram Premium. Остальные видят обычные эмодзи.

**Q: Как добавить новый эмодзи в систему?**  
A: Отредактируйте `PREMIUM_EMOJI_MAP` в `app/premium_emojis.js`

**Q: Можно ли использовать обычные эмодзи?**  
A: Да, система автоматически заменяет только те что в маппе.

## 🧪 Тестирование

```bash
npm test -- --test tests/premium_emojis.test.js
# Result: 97/97 passing ✅
```

---

📖 Подробнее см. [PREMIUM_EMOJIS_GUIDE.md](./PREMIUM_EMOJIS_GUIDE.md)
