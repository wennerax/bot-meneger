# 🎨 Система Премиум Эмодзи для Telegram Bot

Позволяет легко использовать премиум эмодзи в кнопках, сообщениях и других местах бота.

## 📋 Установка

Импортируйте в `bot.js`:

```javascript
const { 
  replacePremiumEmojis, 
  getPremiumEmoji, 
  EMOJI_NAMES,
  createCustomEmojiMap 
} = require('./premium_emojis');
```

---

## 🚀 Способ 1: Замена эмодзи в строках

Автоматически заменяет все эмодзи в тексте на премиум версии:

```javascript
// Простой текст
const text1 = replacePremiumEmojis('Спасибо ❤️ за помощь! 👍');
// Результат: 'Спасибо ❤️‍🔥 за помощь! 👍'

// В сообщениях бота
await ctx.reply(replacePremiumEmojis('✅ Готово! 🎉'));

// В кнопках меню
keyboard: [
  [{ 
    text: replacePremiumEmojis('❤️ Лайк'),
    callback_data: 'like'
  }]
]
```

---

## 🎯 Способ 2: Получение эмодзи по имени

Удобно для кода, когда хотите использовать по названию:

```javascript
// По имени из EMOJI_NAMES
const likeEmoji = getPremiumEmoji('like');           // 👍
const heartEmoji = getPremiumEmoji('fire_heart');    // ❤️‍🔥
const checkEmoji = getPremiumEmoji('check');         // ✅
const partyEmoji = getPremiumEmoji('party');         // 🎉

// В кнопке
{ text: `${getPremiumEmoji('like')} Нравится`, callback_data: 'like' }

// В сообщении
await ctx.reply(`${getPremiumEmoji('check')} Вы добавлены!`);

// В кастомном тексте
const message = `
${getPremiumEmoji('party')} Поздравляем!
${getPremiumEmoji('trophy')} Вы лучший!
${getPremiumEmoji('fire')} Невероятно!
`;
await ctx.reply(message);
```

---

## 📚 Доступные эмодзи по имени (EMOJI_NAMES)

### Сердечки
```javascript
getPremiumEmoji('heart')           // ❤️
getPremiumEmoji('fire_heart')      // ❤️‍🔥
getPremiumEmoji('orange_heart')    // 🧡
getPremiumEmoji('yellow_heart')    // 💛
getPremiumEmoji('green_heart')     // 💚
getPremiumEmoji('blue_heart')      // 💙
getPremiumEmoji('purple_heart')    // 💜
```

### Огонь и горячие эмодзи
```javascript
getPremiumEmoji('fire')            // 🔥
getPremiumEmoji('boom')            // 💥
getPremiumEmoji('lightning')       // ⚡
```

### Жесты
```javascript
getPremiumEmoji('like')            // 👍
getPremiumEmoji('dislike')         // 👎
getPremiumEmoji('pray')            // 🙏
```

### Лица и эмоции
```javascript
getPremiumEmoji('laugh')           // 😂
getPremiumEmoji('love')            // 😍
getPremiumEmoji('happy')           // 😊
getPremiumEmoji('star_eyes')       // 🤩
getPremiumEmoji('cool')            // 😎
getPremiumEmoji('thinking')        // 🤔
getPremiumEmoji('shocked')         // 😱
getPremiumEmoji('raised_eyebrow')  // 🤨
getPremiumEmoji('smirk')           // 😏
```

### Праздничные
```javascript
getPremiumEmoji('party')           // 🎉
getPremiumEmoji('confetti')        // 🎊
getPremiumEmoji('balloon')         // 🎈
getPremiumEmoji('gift')            // 🎁
getPremiumEmoji('trophy')          // 🏆
```

### Звезды и сияние
```javascript
getPremiumEmoji('star')            // ⭐
getPremiumEmoji('sparkles')        // ✨
```

### Числа и символы
```javascript
getPremiumEmoji('hundred')         // 💯
getPremiumEmoji('cross')           // ❌
getPremiumEmoji('check')           // ✅
getPremiumEmoji('warning')         // ⚠️
getPremiumEmoji('exclamation')     // ❗
```

### Действия и символы
```javascript
getPremiumEmoji('bell')            // 🔔
getPremiumEmoji('speaker')         // 📢
getPremiumEmoji('megaphone')       // 📣
getPremiumEmoji('lock')            // 🔒
getPremiumEmoji('unlock')          // 🔓
getPremiumEmoji('chat')            // 💬
getPremiumEmoji('link')            // 🔗
getPremiumEmoji('settings')        // ⚙️
getPremiumEmoji('ban')             // 🚫
getPremiumEmoji('shield')          // 🛡️
getPremiumEmoji('puzzle')          // 🧩
getPremiumEmoji('robot')           // 🤖
```

### Стрелки
```javascript
getPremiumEmoji('left')            // ⬅️
getPremiumEmoji('right')           // ➡️
getPremiumEmoji('up')              // ⬆️
getPremiumEmoji('down')            // ⬇️
```

---

## 🎛️ Способ 3: Кастомный маппинг для конкретного меню

Если хотите заменить эмодзи только в определенной секции кода:

```javascript
// Создать кастомный маппинг с переопределениями
const customEmojis = createCustomEmojiMap({
  '❤️': '💖',          // Заменить обычное сердце на другое
  '🎉': '🎊🎈',       // Заменить конфетти на комбинацию
  '✅': '✔️',           // Заменить галочку
});

// Использовать только для этого текста
const buttonText = replacePremiumEmojis('❤️ Лайк', customEmojis);
```

---

## 💡 Примеры использования в коде

### В главном меню настроек:
```javascript
function buildSettingsMainKeyboard(chatId) {
  return {
    inline_keyboard: [
      [
        { text: `${getPremiumEmoji('puzzle')} Капча`, callback_data: `settings:section:captcha:${chatId}` },
        { text: `${getPremiumEmoji('link')} Ссылки`, callback_data: `settings:section:links:${chatId}` },
      ],
      [
        { text: `${getPremiumEmoji('shield')} Антиспам`, callback_data: `settings:section:anti:${chatId}` },
        { text: `${getPremiumEmoji('list')} Правила`, callback_data: `settings:section:rules:${chatId}` },
      ],
      // ... остальное
    ],
  };
}
```

### В сообщениях команд:
```javascript
bot.command('help', async (ctx) => {
  await ctx.reply(replacePremiumEmojis(`
${getPremiumEmoji('info')} Доступные команды:

${getPremiumEmoji('settings')} /settings - Настройки
${getPremiumEmoji('ban')} /ban - Забанить пользователя
${getPremiumEmoji('fire')} /warn - Предупредить
${getPremiumEmoji('shield')} /mute - Заглушить

${getPremiumEmoji('fire')} Созданы с любовью ${getPremiumEmoji('fire_heart')}
  `));
});
```

### В кнопках с динамическим выбором:
```javascript
function buildLikeButton(isLiked) {
  const emoji = isLiked ? getPremiumEmoji('fire_heart') : getPremiumEmoji('heart');
  const count = isLiked ? '💯' : '10';
  
  return {
    text: `${emoji} Лайк ${count}`,
    callback_data: 'like_toggle'
  };
}
```

### В модерационных командах:
```javascript
bot.command('warn', async (ctx) => {
  await replyWithAutoDelete(
    ctx,
    replacePremiumEmojis(`${getPremiumEmoji('warning')} Вам выдано предупреждение!\n${getPremiumEmoji('fire')} Будьте осторожны!`),
    {},
    5000
  );
});
```

---

## ⚙️ Продвинутые возможности

### Получить весь маппинг:
```javascript
const map = getEmojiMap();
console.log(map); // Объект со всеми заменами
```

### Установить глобальный кастомный маппинг:
```javascript
// Переопределить эмодзи на глобальном уровне для всего бота
setCustomEmojiMap({
  '❤️': '💗',
  '🔥': '🌟',
  '✅': '☑️',
});

// Теперь все замены будут использовать новые эмодзи
replacePremiumEmojis('❤️ Спасибо'); // '💗 Спасибо'
```

---

## 📌 Тип сообщений, где работают эмодзи

✅ **Работает везде:**
- Текст сообщений
- Текст кнопок (inline_keyboard)
- Описание кнопок
- Подписи к фото/видео
- HTML/Markdown форматирование

❌ **Ограничения:**
- Премиум эмодзи видны только пользователям с подписанным Telegram Premium аккаунтом
- На других устройствах отображаются обычные версии
- Некоторые эмодзи могут не поддерживаться на старых версиях Telegram

---

## 🎓 Краткая шпаргалка

```javascript
// Импорт
const { replacePremiumEmojis, getPremiumEmoji } = require('./premium_emojis');

// Заменить эмодзи в тексте
replacePremiumEmojis('Спасибо ❤️'); 

// Получить эмодзи по имени
getPremiumEmoji('like')  // 👍
getPremiumEmoji('check') // ✅
getPremiumEmoji('fire')  // 🔥

// Комбинировать
const msg = `${getPremiumEmoji('party')} ${replacePremiumEmojis('Поздравляем! ❤️')}`;
```

---

## 🔗 Дополнительные примеры

Смотри примеры использования в комментариях самого файла `premium_emojis.js`.
