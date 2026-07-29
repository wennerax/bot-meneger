class ModerationService {
  constructor() {
    this.chats = new Map();
  }

  _getChat(chatId) {
    const id = Number(chatId);
    if (!this.chats.has(id)) {
      this.chats.set(id, {
        rules: 'Правила чата пока не настроены.',
        greeting: 'Добро пожаловать в чат! Ознакомьтесь с правилами через /rules.',
        warnings: {},
        filters: {},
      });
    }
    return this.chats.get(id);
  }

  getRules(chatId) {
    return this._getChat(chatId).rules;
  }

  setRules(chatId, rules) {
    this._getChat(chatId).rules = rules;
  }

  getGreeting(chatId) {
    return this._getChat(chatId).greeting;
  }

  setGreeting(chatId, greeting) {
    this._getChat(chatId).greeting = greeting;
  }

  addWarning(chatId, userId) {
    const chat = this._getChat(chatId);
    const id = Number(userId);
    chat.warnings[id] = (chat.warnings[id] || 0) + 1;
    return chat.warnings[id];
  }

  getWarnings(chatId, userId) {
    return this._getChat(chatId).warnings[Number(userId)] || 0;
  }

  resetWarnings(chatId, userId) {
    delete this._getChat(chatId).warnings[Number(userId)];
  }

  addFilter(chatId, keyword, response) {
    this._getChat(chatId).filters[String(keyword).trim().toLowerCase()] = response;
  }

  removeFilter(chatId, keyword) {
    const chat = this._getChat(chatId);
    const normalized = String(keyword).trim().toLowerCase();
    if (!(normalized in chat.filters)) {
      return false;
    }
    delete chat.filters[normalized];
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
];

module.exports.getFunnyDescription = () => {
  return FUNNY_DESCRIPTIONS[Math.floor(Math.random() * FUNNY_DESCRIPTIONS.length)];
};
