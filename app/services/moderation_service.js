const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BAN_WORDS = [
  'наркот', 'нарко', 'нарк', 'травка', 'гашиш', 'шишка', 'конопл', 'кокаин', 'кокс', 'героин', 'метадон',
  'амфетамин', 'метамфетамин', 'экстази', 'мдма', 'лсд', 'допинг', 'доза', 'weed', 'cocaine', 'meth',
  'amphetamine', 'mdma', 'lsd', 'hash', 'hashish', 'heroin', 'dope', 'drug', 'drugs', 'selfharm', 'self-harm',
  'suicide', 'самоубийство', 'суицид', 'срезать', 'резать', 'порез', 'нож', 'knife', 'razor', 'blade', 'cutting',
  'смерть', 'умирать', 'хочуумереть', 'selfcut', 'selfcutting', 'убить себя'
];

const DEFAULT_ALLOWED_LINKS = [
  't.me', 'telegram.me', 'telegram.org', 'youtube.com', 'youtu.be', 'vk.com', 'x.com', 'twitter.com',
  'reddit.com', 'github.com', 'gitlab.com', 'stackoverflow.com', 'google.com', 'drive.google.com', 'gmail.com',
  'yandex.ru', 'ya.ru', 'discord.com', 'discord.gg', 'steamcommunity.com', 'apple.com', 'microsoft.com'
];

class ModerationService {
  constructor(filePath = null) {
    this.filePath = filePath || null;
    this.chats = new Map();
    this._load();
  }

  _normalizeChat(chat = {}) {
    return {
      rules: chat.rules ?? 'Правила чата пока не настроены.',
      greeting: chat.greeting ?? 'Добро пожаловать в чат! Ознакомьтесь с правилами через /rules.',
      warnings: chat.warnings && typeof chat.warnings === 'object'
        ? Object.fromEntries(Object.entries(chat.warnings).map(([key, value]) => [String(key), Number(value)]))
        : {},
      filters: chat.filters && typeof chat.filters === 'object' ? { ...chat.filters } : {},
      banWords: Array.isArray(chat.banWords)
        ? [...new Set(chat.banWords.map((item) => String(item).trim().toLowerCase()).filter(Boolean))]
        : [...DEFAULT_BAN_WORDS],
      allowedLinks: Array.isArray(chat.allowedLinks)
        ? [...new Set(chat.allowedLinks.map((item) => String(item).trim().toLowerCase()).filter(Boolean))]
        : [...DEFAULT_ALLOWED_LINKS],
      spamProtectionEnabled: Boolean(chat.spamProtectionEnabled),
      linkProtectionEnabled: Boolean(chat.linkProtectionEnabled),
      floodProtectionEnabled: Boolean(chat.floodProtectionEnabled),
    };
  }

  _load() {
    if (!this.filePath) {
      return;
    }

    try {
      if (!fs.existsSync(this.filePath)) {
        return;
      }

      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw.trim()) {
        return;
      }

      const parsed = JSON.parse(raw);
      const source = parsed.moderation?.chats || parsed.chats || parsed;
      const entries = Object.entries(source || {}).filter(([, value]) => value && typeof value === 'object');
      this.chats = new Map(entries.map(([chatId, chat]) => [Number(chatId), this._normalizeChat(chat)]));
    } catch (error) {
      this.chats = new Map();
    }
  }

  _save() {
    if (!this.filePath) {
      return;
    }

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    let payload = {};
    try {
      const existing = fs.readFileSync(this.filePath, 'utf8').trim();
      if (existing) {
        const parsed = JSON.parse(existing);
        if (parsed && typeof parsed === 'object') {
          payload = parsed;
        }
      }
    } catch (error) {
      payload = {};
    }

    payload.moderation = {
      chats: Object.fromEntries(
        Array.from(this.chats.entries()).map(([chatId, chat]) => [String(chatId), this._normalizeChat(chat)])
      ),
    };

    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2));
  }

  _getChat(chatId) {
    const id = Number(chatId);
    if (!this.chats.has(id)) {
      this.chats.set(id, this._normalizeChat());
    }
    return this.chats.get(id);
  }

  getRules(chatId) {
    return this._getChat(chatId).rules;
  }

  setRules(chatId, rules) {
    this._getChat(chatId).rules = rules;
    this._save();
  }

  getGreeting(chatId) {
    return this._getChat(chatId).greeting;
  }

  setGreeting(chatId, greeting) {
    this._getChat(chatId).greeting = greeting;
    this._save();
  }

  addWarning(chatId, userId) {
    const chat = this._getChat(chatId);
    const id = Number(userId);
    chat.warnings[id] = (chat.warnings[id] || 0) + 1;
    this._save();
    return chat.warnings[id];
  }

  getWarnings(chatId, userId) {
    return this._getChat(chatId).warnings[Number(userId)] || 0;
  }

  resetWarnings(chatId, userId) {
    delete this._getChat(chatId).warnings[Number(userId)];
    this._save();
  }

  resetAllWarnings(chatId) {
    this._getChat(chatId).warnings = {};
    this._save();
  }

  enableSpamProtection(chatId) {
    this._getChat(chatId).spamProtectionEnabled = true;
    this._save();
  }

  disableSpamProtection(chatId) {
    this._getChat(chatId).spamProtectionEnabled = false;
    this._save();
  }

  isSpamProtectionEnabled(chatId) {
    return Boolean(this._getChat(chatId).spamProtectionEnabled);
  }

  enableLinkProtection(chatId) {
    this._getChat(chatId).linkProtectionEnabled = true;
    this._save();
  }

  disableLinkProtection(chatId) {
    this._getChat(chatId).linkProtectionEnabled = false;
    this._save();
  }

  isLinkProtectionEnabled(chatId) {
    return Boolean(this._getChat(chatId).linkProtectionEnabled);
  }

  enableFloodProtection(chatId) {
    this._getChat(chatId).floodProtectionEnabled = true;
    this._save();
  }

  disableFloodProtection(chatId) {
    this._getChat(chatId).floodProtectionEnabled = false;
    this._save();
  }

  isFloodProtectionEnabled(chatId) {
    return Boolean(this._getChat(chatId).floodProtectionEnabled);
  }

  addFilter(chatId, keyword, response) {
    this._getChat(chatId).filters[String(keyword).trim().toLowerCase()] = response;
    this._save();
  }

  removeFilter(chatId, keyword) {
    const chat = this._getChat(chatId);
    const normalized = String(keyword).trim().toLowerCase();
    if (!(normalized in chat.filters)) {
      return false;
    }
    delete chat.filters[normalized];
    this._save();
    return true;
  }

  findFilterResponse(chatId, text) {
    const chat = this._getChat(chatId);
    const normalized = String(text).toLowerCase();
    for (const [keyword, response] of Object.entries(chat.filters)) {
      if (normalized.includes(keyword)) {
        return response;
      }
    }
    return null;
  }

  getBanWords(chatId) {
    return [...this._getChat(chatId).banWords];
  }

  addBanWord(chatId, word) {
    const chat = this._getChat(chatId);
    const normalized = String(word || '').trim().toLowerCase();
    if (!normalized || chat.banWords.includes(normalized)) {
      return false;
    }
    chat.banWords.push(normalized);
    this._save();
    return true;
  }

  removeBanWord(chatId, word) {
    const chat = this._getChat(chatId);
    const normalized = String(word || '').trim().toLowerCase();
    const before = chat.banWords.length;
    chat.banWords = chat.banWords.filter((item) => item !== normalized);
    if (chat.banWords.length === before) {
      return false;
    }
    this._save();
    return true;
  }

  findBanWord(chatId, text) {
    const normalizedText = String(text || '').toLowerCase().replace(/[^a-zа-я0-9]/g, '');
    if (!normalizedText) {
      return null;
    }

    for (const word of this._getChat(chatId).banWords) {
      const normalizedWord = String(word || '').toLowerCase().replace(/[^a-zа-я0-9]/g, '');
      if (!normalizedWord) {
        continue;
      }
      if (normalizedText.includes(normalizedWord) || normalizedWord.includes(normalizedText)) {
        return word;
      }
    }
    return null;
  }

  getAllowedLinks(chatId) {
    return [...this._getChat(chatId).allowedLinks];
  }

  addAllowedLink(chatId, value) {
    const chat = this._getChat(chatId);
    const normalized = String(value || '').trim().toLowerCase().replace(/^https?:\/\//i, '').replace(/^www\./i, '');
    if (!normalized || chat.allowedLinks.includes(normalized)) {
      return false;
    }
    chat.allowedLinks.push(normalized);
    this._save();
    return true;
  }

  removeAllowedLink(chatId, value) {
    const chat = this._getChat(chatId);
    const normalized = String(value || '').trim().toLowerCase().replace(/^https?:\/\//i, '').replace(/^www\./i, '');
    const before = chat.allowedLinks.length;
    chat.allowedLinks = chat.allowedLinks.filter((item) => item !== normalized);
    if (chat.allowedLinks.length === before) {
      return false;
    }
    this._save();
    return true;
  }

  isAllowedLink(chatId, value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    const hostname = normalized.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0];
    return this._getChat(chatId).allowedLinks.some((item) => {
      const normalizedItem = String(item || '').trim().toLowerCase().replace(/^https?:\/\//i, '').replace(/^www\./i, '');
      return hostname === normalizedItem || hostname.endsWith(`.${normalizedItem}`);
    });
  }
}

module.exports = ModerationService;

const FUNNY_DESCRIPTIONS = [
  'Вы - живой мем',
  'Вы - босс переговоров',
  'Вы - мастер спама',
  'Вы - король копипасты',
  'Вы - легенда чата',
  'Вы - рассеянный профессор',
  'Вы - проводник мудрости',
  'Вы - живая энциклопедия',
  'Вы - боевой товарищ',
  'Вы - инженер хаоса',
  'Вы - архитектор проблем',
  'Вы - мастер вопросов',
  'Вы - ценитель юмора',
  'Вы - душа компании',
  'Вы - король острот',
  'Вы - человек, который всё делает по-своему',
  'Вы - главный источник хаоса в этом чате',
  'Вы - тот самый человек, которого все помнят',
  'Вы - живой фейерверк без плана',
  'Вы - мастер делать вид, что всё под контролем',
  'Вы - человек, у которого всегда есть мнение',
  'Вы - существо, которое делает чат интереснее',
  'Вы - бунтарь в мире спокойствия',
  'Вы - герой, которого не ждали, но уже заметили',
  'Вы - человек с очень странным чувством юмора',
  'Вы - тот самый, кто умеет всё испортить красиво',
  'Вы - пьяный гений, если не в меру',
  'Вы - человек с характером, как у бури',
  'Вы - бесконечный источник шума и веселья',
  'Вы - такой же яркий, как пожар в сухой траве',
  'Вы - тип, который влезает в любой бардак и делает его своим',
  'Вы - человек, который знает, как разогреть атмосферу',
  'Вы - брутальный кусок реальности',
  'Вы - маленький хаос в человеческом обличье',
  'Вы - тот, кто делает вид, что всё нормально, хотя всё уже не нормально',
  'Вы - мастер превращать скуку в цирк',
  'Вы - человек, которому хватило бы одной фразы, чтобы всех вывести из себя',
  'Вы - сам себе и проблема, и решение',
  'Вы - натуральный пиздец по части вайба',
  'Вы - полный мудак, но с шармом',
  'Вы - такой человек, что даже воздух вокруг вас начинает нервничать',
  'Вы - урод, но в хорошем смысле',
  'Вы - долбоёб с талантами',
  'Вы - сука, но очень интересная',
  'Вы - чёртов мастер поднимать панику',
  'Вы - человек, который любит всех бесить и при этом быть любимым',
  'Вы - яркий как пламя, опасный как короткое замыкание',
  'Вы - тип, с которым лучше не спорить без плана отхода',
  'Вы - тот самый, кто может словить пиздюлей от жизни и всё равно улыбнуться',
  'Вы - гребаная смесь гениальности и безумия',
  'Вы - персонаж, которого вечно не хватает в драме',
  'Вы - человек, который делает вид, что не ебёт мозги, но ебёт их очень убедительно',
  'Вы - не просто человек, а целое дерьмо с характером',
  'Вы - такой же неприятный, как правдивая мысль в неподходящий момент',
  'Вы - мразь, но с харизмой',
  'Вы - веселая хуйня',
  'Вы - тот, кого вечно помнят, потому что с ним сложно',
  'Вы - лучшее, что могло случиться с этим чатом, даже если это звучит как издевка',
  'Вы - живая катастрофа с улыбкой',
  'Вы - настоящий еблан с редким обаянием',
  'Вы - ходячее говно, которое ещё и талдычит',
  'Вы - такой же полезный, как говно в проруби',
  'Вы - тупой как пробка, но злой как бульдозер',
  'Вы - шелудивая мразь с чёрным юмором',
  'Вы - хуйня с человеческим лицом',
  'Вы - самый харизматичный долбоёб, которого я видел',
  'Вы - дрянной урод, который всё портит, но при этом не может остановиться',
  'Вы - кусок мерзости, которого ещё и жалко',
  'Вы - говнецо, которое раскрашивает жизнь в серый',
  'Вы - тупой мудак, с которым весело только тогда, когда его нет рядом',
  'Вы - конченый еблан, который умудряется быть хуже всех',
  'Вы - пиздец без мозгов, которого ещё и жаль',
  'Вы - хуйня, которая вечно норовит облажаться',
  'Вы - говно на палочке, но с претензиями на короля',
];

module.exports.getFunnyDescription = () => {
  return FUNNY_DESCRIPTIONS[Math.floor(Math.random() * FUNNY_DESCRIPTIONS.length)];
};
