# 🎨 Кастомные ID Эмодзи Telegram

Использование премиум эмодзи Telegram с красивыми эффектами через ID.

## 🚀 Быстрый старт

### Способ 1: Самый простой

```javascript
const { replyWithCustomEmoji } = require('./app/premium_emojis');

// Отправить сообщение с кастомным эмодзи
await replyWithCustomEmoji(
  ctx,
  'Люблю {heart} этот бот!',
  { '{heart}': 'heart_purple' }
);
```

**Результат:**
- 🎨 Premium пользователи: фиолетовое сердце с красивым эффектом
- 👤 Обычные пользователи: 💜 обычное фиолетовое сердце

### Способ 2: Получить ID или fallback

```javascript
const { getCustomEmojiId, getCustomEmojiFallback } = require('./app/premium_emojis');

const id = getCustomEmojiId('heart_purple');      // '5328145443106873128'
const fallback = getCustomEmojiFallback('heart_purple'); // '💜'
```

### Способ 3: Несколько эмодзи в одном сообщении

```javascript
await replyWithCustomEmoji(
  ctx,
  'Красивая {pink_flower} композиция {blue_flower} цветов!',
  {
    '{pink_flower}': 'flower_pink',
    '{blue_flower}': 'flower_blue',
  }
);
```

## 📚 Доступные кастомные эмодзи

### Сердечки
- `heart_purple` - Фиолетовое сердце с эффектом (ID: 5328145443106873128)
- `heart_pink` - Розовое сердце (ID: 5312949421381177815)
- `heart_fire` - Горящее сердце (ID: 5328151038599003814)

### Цветы
- `flower_pink` - Розовый цветок (ID: 5312948834137047286)
- `flower_blue` - Синий цветок (ID: 5312947055836119424)

### Персонажи
- `cat_happy` - Счастливый кот (ID: 5325885244695425655)
- `angel` - Ангел (ID: 5328147729537945974)

### Звезды
- `star_purple` - Фиолетовая звезда (ID: 5328146574935768874)

---

## 💡 Примеры использования

### В команде
```javascript
bot.command('love', async (ctx) => {
  await replyWithCustomEmoji(
    ctx,
    'Спасибо {heart} за поддержку!',
    { '{heart}': 'heart_purple' }
  );
});
```

### В callback обработке
```javascript
bot.action('emoji:heart', async (ctx) => {
  await replyWithCustomEmoji(
    ctx,
    'Вы выбрали: {heart}',
    { '{heart}': 'heart_purple' }
  );
});
```

### С дополнительными опциями
```javascript
await replyWithCustomEmoji(
  ctx,
  'Сообщение {flower}',
  { '{flower}': 'flower_pink' },
  {
    reply_to_message_id: ctx.message.message_id,
    disable_notification: true,
  }
);
```

---

## 🔧 API Функции

### `replyWithCustomEmoji(ctx, text, emojis, options)`
Отправить сообщение с кастомными эмодзи

**Параметры:**
- `ctx` - Telegraf контекст
- `text` - Текст с плейсхолдерами (например: `"Люблю {heart}"`)
- `emojis` - Объект маппинга плейсхолдеров на имена эмодзи
  - Пример: `{ '{heart}': 'heart_purple' }`
- `options` - Дополнительные опции для `ctx.reply` (опционально)

**Возвращает:** Promise с результатом отправки сообщения

### `getCustomEmojiId(emojiName)`
Получить ID эмодзи

**Параметры:**
- `emojiName` - Имя эмодзи из CUSTOM_EMOJI_IDS

**Возвращает:** ID эмодзи (string) или null

### `getCustomEmojiFallback(emojiName)`
Получить fallback эмодзи для старых версий Telegram

**Параметры:**
- `emojiName` - Имя эмодзи

**Возвращает:** Fallback эмодзи (обычный символ)

### `getCustomEmojiInfo(emojiName)`
Получить полную информацию об эмодзи

**Возвращает:** 
```javascript
{
  id: '5328145443106873128',
  fallback: '💜',
  displayName: 'Фиолетовое сердце'
}
```

### `addCustomEmoji(name, customEmojiId, fallback, displayName)`
Добавить новый кастомный эмодзи в систему

**Параметры:**
- `name` - Уникальное имя эмодзи
- `customEmojiId` - ID из Telegram
- `fallback` - Обычный эмодзи для fallback
- `displayName` - Описание (опционально)

**Пример:**
```javascript
addCustomEmoji('my_cat', '5325885244695425655', '😸', 'Мой кот');
```

### `getAllCustomEmojis()`
Получить все кастомные эмодзи

**Возвращает:** Объект со всеми эмодзи

### `hasCustomEmoji(emojiName)`
Проверить есть ли эмодзи в системе

**Возвращает:** boolean

### `createCustomEmojiEntity(emojiName, offset)`
Создать Entity объект для Telegram API (продвинутое использование)

**Параметры:**
- `emojiName` - Имя эмодзи
- `offset` - Позиция в тексте

**Возвращает:** Entity объект или null

---

## 🎯 Как найти ID новых эмодзи

### Способ 1: Telegram Desktop
1. Открой раздел Emoji → Premium
2. Наведи на интересующий эмодзи
3. Скопируй ID (если есть опция)

### Способ 2: Telegram Mobile
1. Длительное нажатие на эмодзи
2. Копировать ID

### Способ 3: Telegram Bot API
```javascript
// Используй метод getCustomEmojiStickers
bot.telegram.getCustomEmojiStickers(['5328145443106873128'])
  .then(stickers => console.log(stickers));
```

---

## ⚙️ Добавление новых ID

1. **Найти ID** в Telegram Premium эмодзи паках
2. **Добавить в код:**

```javascript
const { addCustomEmoji } = require('./app/premium_emojis');

// В начало bot.js (после инициализации)
addCustomEmoji('my_emoji_name', 'НОВЫЙ_ID_ЗДЕСЬ', 'обычный_эмодзи', 'Описание');
```

3. **Использовать:**
```javascript
await replyWithCustomEmoji(ctx, 'Текст {emoji}', { '{emoji}': 'my_emoji_name' });
```

---

## 📖 Полная структура CUSTOM_EMOJI_IDS

```javascript
{
  heart_purple: {
    id: '5328145443106873128',
    fallback: '💜',
    displayName: 'Фиолетовое сердце'
  },
  flower_pink: {
    id: '5312948834137047286',
    fallback: '🌸',
    displayName: 'Розовый цветок'
  },
  // ... остальные эмодзи
}
```

---

## ❓ Часто задаваемые вопросы

**Q: Будет ли эмодзи видно всем?**  
A: Да! Premium пользователи видят красивую версию с эффектом, остальные видят fallback.

**Q: Как добавить свой ID эмодзи?**  
A: Используй функцию `addCustomEmoji()` или отредактируй `CUSTOM_EMOJI_IDS` напрямую.

**Q: Будет ли работать в кнопках меню?**  
A: Да, используй fallback в тексте кнопки и entities для красивого отображения.

**Q: Поддерживаются ли комбинации эмодзи?**  
A: Да, можешь использовать несколько `{placeholder}` в одном сообщении.

---

## 🔗 Дополнительные примеры

Смотри [EXAMPLES_CUSTOM_EMOJI_IDS.js](./EXAMPLES_CUSTOM_EMOJI_IDS.js) для 10+ готовых примеров!
