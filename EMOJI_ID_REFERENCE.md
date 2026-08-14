# 🎨 emoji:id() - Полный Справочник ID

## Как Использовать

```javascript
const { sendWithEmojiSyntax } = require('./app/premium_emojis');

await sendWithEmojiSyntax(ctx, 'Текст emoji:id(ID_СЮДА) текст');
```

Скопируй ID из таблицы ниже и подставь в `emoji:id(ID)`.

---

## 💖 Сердца (Hearts)

| Название | ID | Fallback | Описание |
|----------|-----|----------|---------|
| heart_purple | `5328145443106873128` | 💜 | Фиолетовое сердце с эффектом |
| heart_pink | `5312949421381177815` | 🩷 | Розовое сердце |
| heart_fire | `5328151038599003814` | ❤️‍🔥 | Сердце в огне |

**Примеры:**
```javascript
await sendWithEmojiSyntax(ctx, 'Люблю emoji:id(5328145443106873128) этот бот!');
await sendWithEmojiSyntax(ctx, 'emoji:id(5328151038599003814) Горячо!');
```

---

## 🌸 Цветы (Flowers)

| Название | ID | Fallback | Описание |
|----------|-----|----------|---------|
| flower_pink | `5312948834137047286` | 🌸 | Розовый цветок |
| flower_blue | `5312947055836119424` | 🌹 | Синий цветок |

**Примеры:**
```javascript
await sendWithEmojiSyntax(ctx, 'Красивый emoji:id(5312948834137047286) цветок!');
await sendWithEmojiSyntax(ctx, 'emoji:id(5312947055836119424) Чудо природы!');
```

---

## 😸 Лица (Faces)

| Название | ID | Fallback | Описание |
|----------|-----|----------|---------|
| cat_happy | `5325885244695425655` | 😸 | Счастливый кот |
| angel | `5328147729537945974` | 😇 | Ангел |

**Примеры:**
```javascript
await sendWithEmojiSyntax(ctx, 'emoji:id(5325885244695425655) Мяу!');
await sendWithEmojiSyntax(ctx, 'Ты как emoji:id(5328147729537945974)!');
```

---

## ⭐ Звезды (Stars)

| Название | ID | Fallback | Описание |
|----------|-----|----------|---------|
| star_purple | `5328146574935768874` | ⭐ | Фиолетовая звезда |

**Примеры:**
```javascript
await sendWithEmojiSyntax(ctx, 'Звезда emoji:id(5328146574935768874) блистает!');
await sendWithEmojiSyntax(ctx, '⭐ emoji:id(5328146574935768874) Отлично!');
```

---

## 🔥 Рекомендуемые Комбинации

### 1. Приветствие
```javascript
await sendWithEmojiSyntax(ctx, `
Привет! emoji:id(5325885244695425655)

Добро пожаловать в наш чат! emoji:id(5328147729537945974)
`);
```

### 2. Успех
```javascript
await sendWithEmojiSyntax(ctx, `
emoji:id(5328147729537945974) Успешно!

Спасибо за внимание! emoji:id(5328146574935768874)
`);
```

### 3. Меню
```javascript
await sendWithEmojiSyntax(ctx, `
Выбери действие emoji:id(5328146574935768874):

emoji:id(5328145443106873128) Вариант 1
emoji:id(5312948834137047286) Вариант 2
emoji:id(5325885244695425655) Вариант 3
`);
```

### 4. Любовь
```javascript
await sendWithEmojiSyntax(ctx, `
emoji:id(5328145443106873128) 
emoji:id(5312949421381177815) 
emoji:id(5328151038599003814)

Люблю этот бот!
`);
```

### 5. Спасибо
```javascript
await sendWithEmojiSyntax(ctx, `
emoji:id(5328147729537945974) Спасибо!

Благодарим за использование emoji:id(5328146574935768874)
`);
```

---

## 📋 Таблица для Копирования

```
5328145443106873128  = 💜 Фиолетовое сердце
5312949421381177815  = 🩷 Розовое сердце
5328151038599003814  = ❤️‍🔥 Горящее сердце
5312948834137047286  = 🌸 Розовый цветок
5312947055836119424  = 🌹 Синий цветок
5325885244695425655  = 😸 Счастливый кот
5328147729537945974  = 😇 Ангел
5328146574935768874  = ⭐ Фиолетовая звезда
```

---

## 💡 Советы

### Совет 1: Множество эмодзи подряд
```javascript
await sendWithEmojiSyntax(ctx, `
emoji:id(5328145443106873128)
emoji:id(5312949421381177815)
emoji:id(5328151038599003814)
`);
```

### Совет 2: Эмодзи в середине текста
```javascript
await sendWithEmojiSyntax(ctx, 'Я люблю emoji:id(5328145443106873128) тебя!');
```

### Совет 3: С форматированием
```javascript
await sendWithEmojiSyntax(ctx, 'emoji:id(5328146574935768874) *Важно!*', {
  parse_mode: 'Markdown',
});
```

### Совет 4: С кнопками
```javascript
await sendWithEmojiSyntax(ctx, 'emoji:id(5328146574935768874) Меню:', {
  reply_markup: {
    inline_keyboard: [[{ text: 'Кнопка', callback_data: 'btn' }]],
  },
});
```

---

## ✅ Проверка

Все работает? Запусти:

```bash
node test-emoji-syntax.js
```

Должны увидеть:
```
✅ PASSED x8
```

---

## 🔍 Как Найти Новый ID?

1. Откри Telegram Premium эмодзи
2. Выбери эмодзи
3. Скопируй его
4. Используй специальный инструмент для извлечения ID (или спроси у AI)
5. Добавь в код: `emoji:id(НОВЫЙ_ID)`

---

## 📚 Больше Информации

- [README_EMOJI_ID_SYNTAX.md](./README_EMOJI_ID_SYNTAX.md) - Полная документация
- [EMOJI_ID_SYNTAX_GUIDE.md](./EMOJI_ID_SYNTAX_GUIDE.md) - Детальное руководство
- [EXAMPLES_EMOJI_SYNTAX.js](./EXAMPLES_EMOJI_SYNTAX.js) - 10+ примеров
- [INTEGRATION_GUIDE.md](./INTEGRATION_GUIDE.md) - Как интегрировать в bot.js
- [test-emoji-syntax.js](./test-emoji-syntax.js) - Тестовый скрипт

---

## 🚀 Начни Прямо Сейчас!

```javascript
const { sendWithEmojiSyntax } = require('./app/premium_emojis');

bot.command('start', async (ctx) => {
  await sendWithEmojiSyntax(ctx, `
Привет! emoji:id(5325885244695425655)

Это бот с красивыми эмодзи emoji:id(5328145443106873128)

Используй /menu для просмотра команд emoji:id(5328146574935768874)
  `);
});
```

**Готово!** Наслаждайся красивыми эмодзи 🎨
