# 🎨 emoji:id() - Кастомные Эмодзи в Телеграм Боте

## ⚡ Быстрый Старт (30 секунд)

### Импорт
```javascript
const { sendWithEmojiSyntax } = require('./app/premium_emojis');
```

### Использование
```javascript
// Просто отправь текст с emoji:id(ТГ_ID)
await sendWithEmojiSyntax(ctx, 'Люблю emoji:id(5328145443106873128) этот бот!');
```

**Готово!** 🎉

---

## 📝 Что это?

**Простой синтаксис для добавления красивых Telegram Premium эмодзи в сообщения**

Вместо того чтобы использовать плейсхолдеры и маппинги, можешь писать прямо в текст:

```javascript
// ❌ Было сложно
await replyWithCustomEmoji(ctx, 'Люблю {heart}', { '{heart}': 'heart_purple' });

// ✅ Теперь просто
await sendWithEmojiSyntax(ctx, 'Люблю emoji:id(5328145443106873128)');
```

---

## 🔍 Формат

```
emoji:id(TELEGRAM_ID)
```

**Примеры:**
- `emoji:id(5328145443106873128)` - Фиолетовое сердце
- `emoji:id(5312949421381177815)` - Розовое сердце
- `emoji:id(5325885244695425655)` - Счастливый кот

---

## 📚 Примеры

### 1. Одна строка
```javascript
await sendWithEmojiSyntax(ctx, 'Привет emoji:id(5328145443106873128)!');
```

### 2. Несколько эмодзи
```javascript
await sendWithEmojiSyntax(ctx, `
emoji:id(5328145443106873128) Сердце
emoji:id(5325885244695425655) Кот
emoji:id(5328146574935768874) Звезда
`);
```

### 3. С кнопками
```javascript
await sendWithEmojiSyntax(ctx, 'Выбери emoji:id(5328146574935768874):', {
  reply_markup: {
    inline_keyboard: [[{ text: 'Выбрать', callback_data: 'select' }]],
  },
});
```

### 4. В коллбеке
```javascript
bot.action('emoji_btn', async (ctx) => {
  await sendWithEmojiSyntax(ctx, 'Спасибо emoji:id(5328147729537945974)!');
});
```

---

## 🎯 Доступные ID Эмодзи

| Описание | ID | Fallback |
|----------|-----|----------|
| Фиолетовое сердце | `5328145443106873128` | 💜 |
| Розовое сердце | `5312949421381177815` | 🩷 |
| Горящее сердце | `5328151038599003814` | ❤️‍🔥 |
| Розовый цветок | `5312948834137047286` | 🌸 |
| Синий цветок | `5312947055836119424` | 🌹 |
| Счастливый кот | `5325885244695425655` | 😸 |
| Ангел | `5328147729537945974` | 😇 |
| Фиолетовая звезда | `5328146574935768874` | ⭐ |

---

## 🛠 Две Основные Функции

### `sendWithEmojiSyntax(ctx, text, options)`

**Отправить сообщение с автоматическим парсингом**

```javascript
await sendWithEmojiSyntax(
  ctx,
  'Люблю emoji:id(5328145443106873128)',
  { parse_mode: 'HTML' } // Опции ctx.reply
);
```

### `parseEmojiSyntax(text)`

**Парсить текст и получить готовый результат вручную**

```javascript
const { text, entities } = parseEmojiSyntax('emoji:id(123)');

// text = обработанный текст с фоллбеком
// entities = готовые для Telegram API

await ctx.reply(text, { entities });
```

---

## ✨ Как это Работает

1. **Парсинг** - ищет паттерны `emoji:id(...)`
2. **Замена** - заменяет на фоллбек эмодзи (💬)
3. **Entities** - создает Telegram entities для премиум эмодзи
4. **Отправка** - отправляет с entities

**Результат:**
- 👤 Premium пользователи - видят красивый эмодзи с эффектами
- 👥 Обычные пользователи - видят фоллбек эмодзи (обычный эмодзи)

---

## 🧪 Тестирование

### Запустить юнит-тесты
```bash
npm test -- --test tests/premium_emojis.test.js
# ✅ 120/120 passing
```

### Запустить демо
```bash
node test-emoji-syntax.js
# Все 8 тестов проходят ✅
```

---

## 📖 Полная Документация

- **[EMOJI_ID_SYNTAX_GUIDE.md](./EMOJI_ID_SYNTAX_GUIDE.md)** - Полная документация
- **[EXAMPLES_EMOJI_SYNTAX.js](./EXAMPLES_EMOJI_SYNTAX.js)** - 10+ готовых примеров
- **[test-emoji-syntax.js](./test-emoji-syntax.js)** - Тестовый скрипт

---

## 💡 Советы

✅ **Можно:**
- Писать много эмодзи подряд: `emoji:id(111) emoji:id(222) emoji:id(333)`
- Смешивать с текстом: `Текст emoji:id(123) текст`
- Использовать с любыми опциями `ctx.reply()`
- Комбинировать с кнопками и другими элементами

❌ **Нельзя:**
- Писать пробелы: `emoji: id(123)` ❌
- Писать буквы в ID: `emoji:id(abc)` ❌
- Забывать скобки: `emoji:id123` ❌

---

## 🔧 Интеграция

### Замени везде
```javascript
// Было
await ctx.reply('Сообщение');

// Стало
await sendWithEmojiSyntax(ctx, 'Сообщение emoji:id(5328145443106873128)');
```

### Или используй парсер
```javascript
const { parseEmojiSyntax } = require('./app/premium_emojis');
const { text, entities } = parseEmojiSyntax('emoji:id(123)');
await ctx.reply(text, { entities });
```

---

## ✅ Статус

- ✅ Реализована функция `parseEmojiSyntax()`
- ✅ Реализована функция `sendWithEmojiSyntax()`
- ✅ 8 новых тестов - все проходят
- ✅ Полная документация
- ✅ 10+ примеров
- ✅ Готово к использованию

---

**Готово использовать!** Просто импортируй `sendWithEmojiSyntax` и наслаждайся красивыми эмодзи 🎨
