# 🎨 emoji:id() Синтаксис для Кастомных Эмодзи

## Суть

Простой способ добавить кастомные Telegram Premium эмодзи прямо в текст сообщения:

```javascript
await sendWithEmojiSyntax(ctx, 'Люблю emoji:id(5328145443106873128) этот бот!');
```

## Формат

```
emoji:id(TELEGRAM_ID)
```

**Где:**
- `emoji:id` - фиксированный префикс
- `(TELEGRAM_ID)` - ID эмодзи из Telegram (только цифры)

## Быстрый Старт

### 1️⃣ Одна строка кода

```javascript
const { sendWithEmojiSyntax } = require('./app/premium_emojis');

// Просто отправь текст с emoji:id() - остальное сделается само!
await sendWithEmojiSyntax(ctx, 'Привет emoji:id(5328145443106873128)!');
```

### 2️⃣ Несколько эмодзи

```javascript
await sendWithEmojiSyntax(
  ctx,
  `Красивые эмодзи:
emoji:id(5328145443106873128) - Фиолетовое сердце
emoji:id(5312949421381177815) - Розовое сердце`
);
```

### 3️⃣ С опциями Telegram

```javascript
await sendWithEmojiSyntax(
  ctx,
  'Текст emoji:id(5328145443106873128) с кнопками',
  {
    reply_markup: {
      inline_keyboard: [[{ text: 'Нажми', callback_data: 'click' }]],
    },
  }
);
```

## 🎯 Доступные ID

| Название | ID | Fallback | Описание |
|----------|-----|----------|---------|
| heart_purple | 5328145443106873128 | 💜 | Фиолетовое сердце |
| heart_pink | 5312949421381177815 | 🩷 | Розовое сердце |
| heart_fire | 5328151038599003814 | ❤️‍🔥 | Горящее сердце |
| flower_pink | 5312948834137047286 | 🌸 | Розовый цветок |
| flower_blue | 5312947055836119424 | 🌹 | Синий цветок |
| cat_happy | 5325885244695425655 | 😸 | Счастливый кот |
| angel | 5328147729537945974 | 😇 | Ангел |
| star_purple | 5328146574935768874 | ⭐ | Фиолетовая звезда |

## 🔧 Основные Функции

### `sendWithEmojiSyntax(ctx, text, options)`

Отправить сообщение с автоматической обработкой `emoji:id()`:

```javascript
// Самый частый случай
await sendWithEmojiSyntax(ctx, 'Текст emoji:id(ID_СЮДА) текст');

// С опциями
await sendWithEmojiSyntax(ctx, 'emoji:id(ID) текст', {
  reply_markup: { inline_keyboard: [...] },
  parse_mode: 'HTML',
});
```

### `parseEmojiSyntax(text)`

Парсить текст и получить результат вручную:

```javascript
const { text, entities } = parseEmojiSyntax('emoji:id(123)');

// text = обработанный текст с фоллбеком
// entities = готовые для Telegram API

// Отправить вручную
await ctx.reply(text, { entities });
```

## 📝 Примеры

### Простое сообщение

```javascript
bot.command('love', async (ctx) => {
  await sendWithEmojiSyntax(
    ctx,
    'Люблю emoji:id(5328145443106873128) этот бот!'
  );
});
```

### Меню с кнопками

```javascript
await sendWithEmojiSyntax(
  ctx,
  'Выбери emoji:id(5328146574935768874):',
  {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'emoji:id(5312948834137047286) Цветок', callback_data: 'flower' }],
        [{ text: 'emoji:id(5325885244695425655) Кот', callback_data: 'cat' }],
      ],
    },
  }
);
```

### Приветствие нового члена

```javascript
bot.on('new_chat_members', async (ctx) => {
  const member = ctx.message.new_chat_members[0];
  
  await sendWithEmojiSyntax(
    ctx,
    `${member.first_name}! emoji:id(5325885244695425655)

emoji:id(5328145443106873128) Добро пожаловать!
emoji:id(5328146574935768874) Помогаем друг другу
emoji:id(5312949421381177815) Весело и дружно!`
  );
});
```

### Множество эмодзи

```javascript
await sendWithEmojiSyntax(
  ctx,
  `emoji:id(5328145443106873128) emoji:id(5312949421381177815) emoji:id(5328151038599003814)`
);
```

## ✨ Преимущества

| Преимущество | Описание |
|-------------|---------|
| **Простота** | Пишешь прямо в строке, никаких плейсхолдеров |
| **Понятность** | Видно где какой эмодзи |
| **Гибкость** | Можно комбинировать с любым текстом |
| **Fallback** | Автоматически подставляется обычный эмодзи для non-Premium |
| **API-совместимость** | Работает с любыми опциями `ctx.reply()` |

## 🚫 Ошибки и Их Решение

### Ошибка: Эмодзи не отображается

**Причина:** Неправильный ID или пользователь без Telegram Premium

**Решение:** Проверь ID, убедись что пользователь Premium, используй `parseEmojiSyntax` для отладки

### Ошибка: Символы странные

**Причина:** Кодировка текста

**Решение:** Убедись что файл сохранен в UTF-8

### Ошибка: parseEmojiSyntax не парсит

**Причина:** Неправильный формат - должно быть `emoji:id(только_цифры)`

**Решение:** 
- Не пиши пробелы: `emoji:id (123)` ❌
- Не пиши буквы: `emoji:id(abc)` ❌
- Правильно: `emoji:id(5328145443106873128)` ✅

## 🔍 Как найти новый ID эмодзи?

1. Открой Telegram Premium эмодзи
2. Скопируй эмодзи в сообщение
3. Используй инструменты для извлечения ID (или спроси у AI)
4. Добавь в код: `await sendWithEmojiSyntax(ctx, 'emoji:id(НОВЫЙ_ID)')`

## 📊 Тестирование

```bash
npm test -- --test tests/premium_emojis.test.js
# ✅ 120/120 passing (включая 8 тестов для emoji:id())
```

## 💾 Интеграция

### Просто замени это:

```javascript
// Было
await ctx.reply('Обычное сообщение');

// Стало
await sendWithEmojiSyntax(ctx, 'Красивое emoji:id(ID) сообщение');
```

### Или используй парсер отдельно:

```javascript
const { text, entities } = parseEmojiSyntax('emoji:id(123)');
await ctx.reply(text, { entities, parse_mode: 'HTML' });
```

## 📖 Больше примеров

Смотри [EXAMPLES_EMOJI_SYNTAX.js](./EXAMPLES_EMOJI_SYNTAX.js) - 10+ готовых примеров!

---

**Готово!** Теперь можешь использовать красивые кастомные эмодзи в боте через простой синтаксис emoji:id() 🎨
