/**
 * Premium Emoji System для Telegram Bot
 * 
 * Поддерживает:
 * 1. Обычные премиум эмодзи
 * 2. Кастомные ID эмодзи Telegram (custom_emoji_id)
 * 3. Автоматический fallback для старых версий Telegram
 * 
 * Использование:
 * 1. Заменить эмодзи в строке: replacePremiumEmojis('Hello ❤️')
 * 2. Получить одиночный эмодзи: getPremiumEmoji('like')
 * 3. Использовать кастомный ID: getCustomEmojiText('like') + ID
 * 4. Отправить сообщение с custom_emoji: replyWithCustomEmoji(ctx, text)
 */

// Маппинг обычных эмодзи на премиум версии
// Ключ: обычный эмодзи, Значение: премиум эмодзи или комбинация
const PREMIUM_EMOJI_MAP = {
  // Сердечки
  '❤️': '❤️‍🔥',      // Обычное сердце → Сердце в огне
  '🧡': '🧡',         // Оранжевое сердце (остается как есть)
  '💛': '💛',         // Желтое сердце
  '💚': '💚',         // Зеленое сердце
  '💙': '💙',         // Синее сердце
  '💜': '💜',         // Фиолетовое сердце
  '🖤': '🖤',         // Черное сердце
  '🤍': '🤍',         // Белое сердце
  '🤎': '🤎',         // Коричневое сердце

  // Огонь и горячие эмодзи
  '🔥': '🔥',         // Огонь (с анимацией)
  '💥': '💥',         // Взрыв
  '⚡': '⚡',         // Молния

  // Популярные жесты
  '👍': '👍',         // Большой палец вверх (с анимацией)
  '👎': '👎',         // Большой палец вниз
  '🙏': '🙏',         // Молитва/спасибо

  // Лица и эмоции
  '😂': '😂',         // Смеюсь до слез
  '😍': '😍💕',       // Лицо с сердечками
  '😊': '😊',         // Счастливое лицо
  '🥰': '🥰',         // Лицо с сердечками
  '😘': '😘',         // Лицо с поцелуем
  '🤩': '🤩✨',       // Восхищенное лицо
  '😎': '😎',         // Крутое лицо
  '🤔': '🤔',         // Задумчивое лицо
  '😱': '😱',         // Шокированное лицо
  '🤨': '🤨',         // Скептическое лицо
  '😏': '😏',         // Насмешливое лицо

  // Праздничные эмодзи
  '🎉': '🎊',         // Конфетти
  '🎊': '🎉',         // Конфетти
  '🎈': '🎈',         // Шар
  '🎁': '🎁',         // Подарок
  '🏆': '🏆',         // Трофей

  // Звезды и сияние
  '⭐': '✨',         // Звезда → Сияние
  '🌟': '✨',         // Сверкающая звезда → Сияние
  '✨': '✨',         // Сияние (с анимацией)
  
  // Числа и символы
  '💯': '💯',         // 100% (с анимацией)
  '❌': '❌',         // Крест
  '✅': '✅',         // Галочка (с анимацией)
  '⚠️': '⚠️',         // Внимание
  '❗': '❗',         // Восклицание

  // Символы действий
  '🔔': '🔔',         // Звонок уведомления
  '📢': '📢',         // Громкоговоритель
  '📣': '📣',         // Мегафон
  '🔒': '🔒',         // Замок
  '🔓': '🔓',         // Открытый замок
  '🔐': '🔐',         // Закрытый замок с ключом

  // Стрелки
  '⬅️': '⬅️',         // Стрелка влево
  '➡️': '➡️',         // Стрелка вправо
  '⬆️': '⬆️',         // Стрелка вверх
  '⬇️': '⬇️',         // Стрелка вниз
  '↔️': '↔️',         // Стрелка влево-вправо
  '↕️': '↕️',         // Стрелка вверх-вниз

  // Специальные символы
  '💬': '💬',         // Речевой пузырь
  '💭': '💭',         // Пузырь мысли
  '🗨️': '🗨️',       // Речевой пузырь
  '🔗': '🔗',         // Ссылка
  '⚙️': '⚙️',         // Шестеренка (настройки)

  // Дополнительные
  '🚫': '🚫',         // Запрет
  '🛡️': '🛡️',       // Щит
  '🧩': '🧩',         // Пазл
  '🤖': '🤖',         // Робот
  '⚖️': '⚖️',         // Весы (справедливость)
  '🎯': '🎯',         // Цель
};

// ==================== КАСТОМНЫЕ ID ЭМОДЗИ TELEGRAM ====================
// Формат: { имя: { id: 'custom_emoji_id', fallback: 'обычный эмодзи' } }
// ID можно получить из Telegram Premium эмодзи пака
const CUSTOM_EMOJI_IDS = {
  // Сердечки (премиум)
  heart_purple: {
    id: '5328145443106873128',  // Фиолетовое сердце с эффектом
    fallback: '💜',
    displayName: 'Фиолетовое сердце'
  },
  heart_pink: {
    id: '5312949421381177815',   // Розовое сердце
    fallback: '🩷',
    displayName: 'Розовое сердце'
  },
  heart_fire: {
    id: '5328151038599003814',   // Горящее сердце
    fallback: '❤️‍🔥',
    displayName: 'Горящее сердце'
  },
  
  // Цветы и природа (премиум)
  flower_pink: {
    id: '5312948834137047286',   // Розовый цветок
    fallback: '🌸',
    displayName: 'Розовый цветок'
  },
  flower_blue: {
    id: '5312947055836119424',   // Синий цветок
    fallback: '🌹',
    displayName: 'Синий цветок'
  },
  
  // Персонажи (премиум)
  cat_happy: {
    id: '5325885244695425655',   // Счастливый кот
    fallback: '😸',
    displayName: 'Счастливый кот'
  },
  angel: {
    id: '5328147729537945974',   // Ангел
    fallback: '😇',
    displayName: 'Ангел'
  },
  
  // Дополнительные (можешь добавить свои)
  star_purple: {
    id: '5328146574935768874',   // Фиолетовая звезда
    fallback: '⭐',
    displayName: 'Фиолетовая звезда'
  },
  
  // Предупреждение и оповещение (премиум)
  warning_alert: {
    id: '5071126104668898462',   // Премиум предупреждение
    fallback: '⚠️',
    displayName: 'Премиум предупреждение'
  },
};

// Маппинг названий эмодзи на символы (для удобного использования)
const EMOJI_NAMES = {
  // Сердечки
  'heart': '❤️',
  'fire_heart': '❤️‍🔥',
  'orange_heart': '🧡',
  'yellow_heart': '💛',
  'green_heart': '💚',
  'blue_heart': '💙',
  'purple_heart': '💜',
  'black_heart': '🖤',
  'white_heart': '🤍',

  // Огонь
  'fire': '🔥',
  'boom': '💥',
  'lightning': '⚡',

  // Жесты
  'like': '👍',
  'dislike': '👎',
  'pray': '🙏',

  // Лица
  'laugh': '😂',
  'love': '😍',
  'happy': '😊',
  'star_eyes': '🤩',
  'cool': '😎',
  'thinking': '🤔',
  'shocked': '😱',
  'raised_eyebrow': '🤨',
  'smirk': '😏',

  // Праздники
  'party': '🎉',
  'confetti': '🎊',
  'balloon': '🎈',
  'gift': '🎁',
  'trophy': '🏆',

  // Звезды
  'star': '⭐',
  'sparkles': '✨',

  // Числа и символы
  'hundred': '💯',
  'cross': '❌',
  'check': '✅',
  'warning': '⚠️',
  'exclamation': '❗',

  // Действия
  'bell': '🔔',
  'speaker': '📢',
  'megaphone': '📣',
  'lock': '🔒',
  'unlock': '🔓',

  // Стрелки
  'left': '⬅️',
  'right': '➡️',
  'up': '⬆️',
  'down': '⬇️',

  // Остальное
  'chat': '💬',
  'link': '🔗',
  'settings': '⚙️',
  'ban': '🚫',
  'shield': '🛡️',
  'puzzle': '🧩',
  'robot': '🤖',
};

/**
 * Заменяет обычные эмодзи на премиум версии в строке
 * @param {string} text - Текст для обработки
 * @param {Object} customMap - Кастомный маппинг (опционально)
 * @returns {string} - Текст с замененными эмодзи
 */
function replacePremiumEmojis(text, customMap = null) {
  if (!text || typeof text !== 'string') {
    return text;
  }

  const emojiMap = customMap || PREMIUM_EMOJI_MAP;
  let result = text;

  // Заменяем каждый эмодзи из маппинга
  for (const [original, premium] of Object.entries(emojiMap)) {
    result = result.split(original).join(premium);
  }

  return result;
}

/**
 * Получить премиум эмодзи по имени или символу
 * @param {string} key - Имя эмодзи (из EMOJI_NAMES) или сам символ
 * @returns {string} - Премиум эмодзи
 */
function getPremiumEmoji(key) {
  // Если это имя из EMOJI_NAMES, преобразуем
  if (EMOJI_NAMES[key]) {
    const baseEmoji = EMOJI_NAMES[key];
    return PREMIUM_EMOJI_MAP[baseEmoji] || baseEmoji;
  }

  // Если это сам эмодзи символ
  if (PREMIUM_EMOJI_MAP[key]) {
    return PREMIUM_EMOJI_MAP[key];
  }

  // Вернуть как есть, если не найдено
  return key;
}

/**
 * Создать кастомный маппинг для конкретной секции
 * @param {Object} overrides - Переопределения эмодзи
 * @returns {Object} - Объединенный маппинг
 */
function createCustomEmojiMap(overrides = {}) {
  return { ...PREMIUM_EMOJI_MAP, ...overrides };
}

/**
 * Получить весь маппинг эмодзи
 * @returns {Object} - Текущий маппинг
 */
function getEmojiMap() {
  return { ...PREMIUM_EMOJI_MAP };
}

/**
 * Установить кастомный маппинг для эмодзи
 * @param {Object} customMap - Новый маппинг
 */
function setCustomEmojiMap(customMap) {
  if (typeof customMap === 'object' && customMap !== null) {
    Object.assign(PREMIUM_EMOJI_MAP, customMap);
  }
}

// ==================== ФУНКЦИИ ДЛЯ КАСТОМНЫХ ID ЭМОДЗИ ====================

/**
 * Получить информацию о кастомном эмодзи по имени
 * @param {string} emojiName - Имя эмодзи (из CUSTOM_EMOJI_IDS)
 * @returns {Object|null} - Объект с id и fallback или null
 */
function getCustomEmojiInfo(emojiName) {
  return CUSTOM_EMOJI_IDS[emojiName] || null;
}

/**
 * Получить ID кастомного эмодзи
 * @param {string} emojiName - Имя эмодзи
 * @returns {string|null} - ID эмодзи или null
 */
function getCustomEmojiId(emojiName) {
  const info = CUSTOM_EMOJI_IDS[emojiName];
  return info ? info.id : null;
}

/**
 * Получить fallback эмодзи (для старых версий Telegram)
 * @param {string} emojiName - Имя эмодзи
 * @returns {string} - Fallback эмодзи или сам emojiName
 */
function getCustomEmojiFallback(emojiName) {
  const info = CUSTOM_EMOJI_IDS[emojiName];
  return info ? info.fallback : emojiName;
}

/**
 * Создать Text Entity для custom emoji (для Telegraf)
 * Используется в ctx.reply с параметром entities
 * 
 * @param {string} emojiName - Имя эмодзи из CUSTOM_EMOJI_IDS
 * @param {number} offset - Позиция в тексте (начиная с 0)
 * @returns {Object|null} - Entity объект для Telegram API
 * 
 * Пример использования:
 * const entities = [createCustomEmojiEntity('heart_purple', 0)];
 * await ctx.reply('Текст', { entities });
 */
function createCustomEmojiEntity(emojiName, offset = 0) {
  const info = CUSTOM_EMOJI_IDS[emojiName];
  if (!info) return null;

  return {
    type: 'custom_emoji',
    offset: offset,
    length: 2,  // Большинство эмодзи занимают 2 символа
    custom_emoji_id: info.id,
  };
}

/**
 * Отправить сообщение с кастомным эмодзи
 * 
 * @param {Object} ctx - Telegraf контекст
 * @param {string} text - Текст сообщения с плейсхолдерами
 * @param {Object} emojis - Маппинг плейсхолдеров на имена эмодзи
 *                         Пример: { '{heart}': 'heart_purple', '{flower}': 'flower_pink' }
 * @param {Object} options - Дополнительные опции для ctx.reply
 * @returns {Promise} - Результат ctx.reply
 * 
 * Пример:
 * await replyWithCustomEmoji(ctx, 'Люблю {heart} этот бот!', 
 *   { '{heart}': 'heart_purple' }
 * );
 */
async function replyWithCustomEmoji(ctx, text, emojis = {}, options = {}) {
  if (!ctx || !text) return null;

  let processedText = text;
  const entities = [];
  let currentOffset = 0;

  // Обработать каждый плейсхолдер
  for (const [placeholder, emojiName] of Object.entries(emojis)) {
    const info = CUSTOM_EMOJI_IDS[emojiName];
    if (!info) continue;

    // Найти позицию плейсхолдера
    const index = processedText.indexOf(placeholder);
    if (index === -1) continue;

    // Заменить плейсхолдер на fallback (для отображения пользователям без premium)
    processedText = processedText.replace(placeholder, info.fallback);

    // Добавить entity для custom emoji
    const actualOffset = index + currentOffset;
    entities.push({
      type: 'custom_emoji',
      offset: actualOffset,
      length: info.fallback.length,
      custom_emoji_id: info.id,
    });

    currentOffset += info.fallback.length - placeholder.length;
  }

  // Отправить сообщение с entities
  // Когда используются entities, parse_mode не должен быть указан
  const finalOptions = { ...options };
  if (entities.length > 0) {
    finalOptions.entities = entities;
    // Удалить parse_mode если он был указан, т.к. entities несовместимы с parse_mode
    delete finalOptions.parse_mode;
  }

  return ctx.reply(processedText, finalOptions);
}

/**
 * Добавить новый кастомный эмодзи в систему
 * @param {string} name - Имя эмодзи (уникальный ключ)
 * @param {string} customEmojiId - ID эмодзи из Telegram
 * @param {string} fallback - Обычный эмодзи для fallback
 * @param {string} displayName - Описание эмодзи (опционально)
 */
function addCustomEmoji(name, customEmojiId, fallback, displayName = '') {
  if (!name || !customEmojiId || !fallback) return false;

  CUSTOM_EMOJI_IDS[name] = {
    id: customEmojiId,
    fallback: fallback,
    displayName: displayName,
  };

  return true;
}

/**
 * Получить все кастомные ID эмодзи
 * @returns {Object} - Копия объекта CUSTOM_EMOJI_IDS
 */
function getAllCustomEmojis() {
  return { ...CUSTOM_EMOJI_IDS };
}

/**
 * Проверить есть ли кастомный эмодзи
 * @param {string} emojiName - Имя эмодзи
 * @returns {boolean}
 */
function hasCustomEmoji(emojiName) {
  return Boolean(CUSTOM_EMOJI_IDS[emojiName]);
}

/**
 * Парсить текст и найти все emoji:id(...) паттерны
 * Преобразует текст в готовое сообщение с entities для Telegram API
 * 
 * @param {string} text - Текст с паттернами типа "Люблю emoji:id(5328145443106873128)"
 * @returns {Object} - { text: 'обработанный текст', entities: [] }
 * 
 * Примеры:
 * parseEmojiSyntax('Люблю emoji:id(5328145443106873128)') 
 * → { text: 'Люблю 💜', entities: [{ type: 'custom_emoji', offset: 6, length: 2, custom_emoji_id: '5328145443106873128' }] }
 */
function parseEmojiSyntax(text) {
  if (!text || typeof text !== 'string') {
    return { text: text || '', entities: [] };
  }

  const entities = [];
  const regex = /emoji:id\((\d+)\)/g;
  const matches = [];
  let match;

  // Найти все совпадения
  while ((match = regex.exec(text)) !== null) {
    matches.push({
      pattern: match[0],
      id: match[1],
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    });
  }

  if (matches.length === 0) {
    return { text, entities: [] };
  }

  // Обработать в обратном порядке для сохранения индексов
  let processedText = text;
  
  for (let i = matches.length - 1; i >= 0; i--) {
    const { pattern, id, startIndex } = matches[i];
    const fallback = '💬'; // Дефолтный fallback эмодзи

    // Заменить паттерн на fallback эмодзи (2 символа в UTF-16)
    processedText = processedText.substring(0, startIndex) + 
                   fallback + 
                   processedText.substring(startIndex + pattern.length);

    // Добавить entity для Telegram (в начало, т.к. обрабатываем в обратном порядке)
    entities.unshift({
      type: 'custom_emoji',
      offset: startIndex,
      length: 2,
      custom_emoji_id: id,
    });
  }

  return {
    text: processedText,
    entities: entities,
  };
}

/**
 * Парсить текст с emoji:id() и отправить сообщение
 * 
 * @param {Object} ctx - Telegraf контекст
 * @param {string} text - Текст сообщения с паттернами "emoji:id(айди)"
 * @param {Object} options - Дополнительные опции для ctx.reply
 * @returns {Promise} - Результат ctx.reply
 * 
 * Пример:
 * await sendWithEmojiSyntax(ctx, 'Люблю emoji:id(5328145443106873128) этот бот!');
 */
async function sendWithEmojiSyntax(ctx, text, options = {}) {
  if (!ctx || !text) return null;

  const { text: processedText, entities } = parseEmojiSyntax(text);

  const finalOptions = {
    ...options,
    entities: entities.length > 0 ? entities : undefined,
  };

  return ctx.reply(processedText, finalOptions);
}

module.exports = {
  replacePremiumEmojis,
  getPremiumEmoji,
  createCustomEmojiMap,
  getEmojiMap,
  setCustomEmojiMap,
  PREMIUM_EMOJI_MAP,
  EMOJI_NAMES,
  
  // Функции для кастомных ID эмодзи
  getCustomEmojiInfo,
  getCustomEmojiId,
  getCustomEmojiFallback,
  createCustomEmojiEntity,
  replyWithCustomEmoji,
  addCustomEmoji,
  getAllCustomEmojis,
  hasCustomEmoji,
  CUSTOM_EMOJI_IDS,

  // Функции для парсинга emoji:id() синтаксиса
  parseEmojiSyntax,
  sendWithEmojiSyntax,
};
