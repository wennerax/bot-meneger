class ModerationService {
  constructor() {
    this.chats = new Map();
  }

  _getChat(chatId) {
    const id = Number(chatId);
    if (!this.chats.has(id)) {
      this.chats.set(id, {
        rules: 'Правила чата пока не настроены.',
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
