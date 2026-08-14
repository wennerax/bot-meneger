# 🎨 Кастомные ID Эмодзи - Быстрый Старт

## Что это?

Премиум эмодзи Telegram которые отображаются с красивыми эффектами для пользователей с Premium подпиской.

## Самый быстрый способ (1 строка)

```javascript
const { replyWithCustomEmoji } = require('./app/premium_emojis');

// Отправить сообщение
await replyWithCustomEmoji(ctx, 'Люблю {heart}', { '{heart}': 'heart_purple' });
```

**Результат:**
- 🎨 Premium пользователи: фиолетовое сердце с эффектом
- 👤 Обычные пользователи: 💜 обычное сердце

## 📌 Доступные эмодзи

| Имя | Fallback | Описание |
|-----|----------|---------|
| `heart_purple` | 💜 | Фиолетовое сердце |
| `heart_pink` | 🩷 | Розовое сердце |
| `heart_fire` | ❤️‍🔥 | Горящее сердце |
| `flower_pink` | 🌸 | Розовый цветок |
| `flower_blue` | 🌹 | Синий цветок |
| `cat_happy` | 😸 | Счастливый кот |
| `angel` | 😇 | Ангел |
| `star_purple` | ⭐ | Фиолетовая звезда |

## 🚀 Примеры

### Один эмодзи
```javascript
await replyWithCustomEmoji(ctx, 'Спасибо {heart}!', { '{heart}': 'heart_purple' });
```

### Несколько эмодзи
```javascript
await replyWithCustomEmoji(
  ctx,
  'Цветы {pink} и {blue} так красивы!',
  { '{pink}': 'flower_pink', '{blue}': 'flower_blue' }
);
```

### В кнопке
```javascript
const fallback = require('./app/premium_emojis').getCustomEmojiFallback('heart_purple');
{ text: `${fallback} Выбрать`, callback_data: 'heart' }
```

## 🔧 Главные функции

```javascript
const {
  replyWithCustomEmoji,        // Отправить сообщение с эмодзи
  getCustomEmojiId,            // Получить ID
  getCustomEmojiFallback,      // Получить fallback
  addCustomEmoji,              // Добавить новый эмодзи
  hasCustomEmoji,              // Проверить наличие
  getAllCustomEmojis,          // Получить все эмодзи
} = require('./app/premium_emojis');
```

## ➕ Добавить новый ID эмодзи

1. **Найти ID** в Telegram Premium эмодзи
2. **Добавить в код:**

```javascript
const { addCustomEmoji } = require('./app/premium_emojis');

addCustomEmoji('my_emoji', '5328145443106873128', '💜', 'Описание');
```

3. **Использовать:**
```javascript
await replyWithCustomEmoji(ctx, 'Текст {emoji}', { '{emoji}': 'my_emoji' });
```

## 📖 Полная документация

- [CUSTOM_EMOJI_IDS_GUIDE.md](./CUSTOM_EMOJI_IDS_GUIDE.md) - полная документация
- [EXAMPLES_CUSTOM_EMOJI_IDS.js](./EXAMPLES_CUSTOM_EMOJI_IDS.js) - 10+ примеров

## ✅ Тестирование

```bash
npm test -- --test tests/premium_emojis.test.js
# Result: 112/112 passing ✅
```

---

Готово! Теперь можешь использовать красивые кастомные эмодзи в боте 🎨

Смотри примеры в [EXAMPLES_CUSTOM_EMOJI_IDS.js](./EXAMPLES_CUSTOM_EMOJI_IDS.js)
