const fs = require('node:fs');
const path = require('node:path');

function readJsonList(filePath, fallback) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return fallback;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) {
      return fallback;
    }

    const normalizedRaw = raw.replace(/^\uFEFF/, '');
    const parsed = JSON.parse(normalizedRaw);
    if (Array.isArray(parsed)) {
      return parsed;
    }

    if (parsed && typeof parsed === 'object') {
      const candidate = parsed.allowedLinks || parsed.allowed_links || parsed.links || parsed.banWords || parsed.ban_words || parsed.words;
      if (Array.isArray(candidate)) {
        return candidate;
      }
    }
  } catch (error) {
    // fall back to embedded defaults
  }

  return fallback;
}

const DEFAULT_BAN_WORDS = readJsonList(path.join(__dirname, '..', 'data', 'ban_words.json'), [
  'наркот', 'нарко', 'нарк', 'травка', 'гашиш', 'шишка', 'конопл', 'кокаин', 'кокс', 'героин', 'метадон',
  'амфетамин', 'метамфетамин', 'экстази', 'мдма', 'лсд', 'допинг', 'доза', 'спайс', 'соль', 'психоактив',
  'мариху', 'марихуан', 'каннабис', 'гандж', 'джойнт', 'спид', 'креоз', 'синтетик', 'синтетич', 'меф', 'мефедрон',
  'фен', 'феназепам', 'бензод', 'трамадол', 'трамал', 'опиат', 'опиум', 'токсик', 'зависим', 'курильщик',
  'курю', 'курит', 'курят', 'пью', 'пьёт', 'пьют', 'пьяница', 'трезв', 'отрав', 'нюха', 'вдых', 'выпив', 'употреб',
  'потребл', 'нарк', 'наркоман', 'наркоманка', 'наркоманский', 'зависимый', 'зависимая', 'токсикоман', 'токсикоманка',
  'вскрыть', 'вскрыться', 'вскроюсь', 'вскрюсь', 'вскрываюсь', 'вскрыться', 'меф', 'кокаин', 'мет', 'долбить соль', 'герыч', 'героин',
  'мдма', 'марихуана', 'нюхать соль', 'курить соль', 'нюхать траву', 'курить траву', 'выпилиться марихуаны', 'снюхать мефедрон',
  'ебать детей', 'повешусь', 'повеситься', 'конопля', 'лсд', 'дезоморфин', 'крэк', 'ебал мать', 'трахал мать', 'мать ебал',
  'мать трахал', 'я ебал твою мать', 'я трахал твою мать', 'кокс', 'метадон', 'водный', 'водник', 'анаша', 'хапка', 'ляпка',
  'гашик', 'гашиш', 'гаш', 'спайс', 'спайсуха', 'кет', 'кетамин', 'джанк', 'фентанил', 'псилоцибин', 'опиаты', 'опиат',
  'обналичиваю пушкинские карты', 'помогите вывести деньги', 'вскроюсь', 'морфий', 'наркотики', 'наркотик', 'токсикомания', 'нарко',
  'вздернуться', 'вздёрнуться', 'вздернусь', 'вздёрнусь', 'маму ебал', 'селфхарм', 'selfharm', 'self-harm', 'suicide', 'самоубийство', 'суицид',
  'chemical', 'chem', 'weed', 'cocaine', 'meth', 'amphetamine', 'mdma', 'lsd', 'hash', 'hashish', 'heroin', 'dope',
  'drug', 'drugs', 'druggie', 'addict', 'addicted', 'срезать', 'резать', 'порез', 'нож', 'knife', 'razor', 'blade', 'cutting', 'смерть', 'умирать', 'хочуумереть',
  'selfcut', 'selfcutting', 'убить себя'
]);

function normalizeAllowedUrl(value) {
  return String(value || '').trim().toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/#.*$/, '');
}

function parseAllowedLinkRule(item) {
  const normalized = normalizeAllowedUrl(item);
  if (!normalized) {
    return null;
  }

  if (!normalized.includes('.') && !normalized.includes('/')) {
    return { type: 'substring', value: normalized };
  }

  const text = normalized.includes('://') ? normalized : `https://${normalized}`;
  try {
    const url = new URL(text);
    const host = url.hostname;
    const path = url.pathname || '/';
    const query = url.search || '';
    const hasTrailingSlash = normalized.endsWith('/');

      if (path === '/' && !query) {
        return { type: 'prefix', value: host };
      }

    const fullPath = `${host}${path}`;
    if (query) {
      return { type: 'exact', value: `${fullPath}${query}` };
    }

    if ((host === 't.me' || host === 'telegram.me') && path !== '/') {
      return { type: 'exact', value: fullPath };
    }

    if (path === '/') {
      return { type: 'exact', value: host };
    }

    if (path.endsWith('/')) {
      return { type: 'prefix', value: `${fullPath}` };
    }

    return { type: 'exact', value: fullPath };
  } catch (error) {
    return { type: 'substring', value: normalized };
  }
}

function normalizeTextPayload(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const text = typeof value.text === 'string' ? value.text : String(value.text ?? '');
    const entities = Array.isArray(value.entities)
      ? value.entities.filter((entity) => entity && typeof entity === 'object').map((entity) => ({ ...entity }))
      : [];
    return { text, entities };
  }

  return { text: String(value ?? ''), entities: [] };
}

function matchesAllowedRule(rule, normalizedUrl) {
  if (!rule || !rule.value || !normalizedUrl) {
    return false;
  }

  if (rule.type === 'substring') {
    return normalizedUrl.includes(rule.value);
  }

  if (rule.type === 'host') {
    const hostname = normalizedUrl.split('/')[0];
    return hostname === rule.value;
  }

  if (rule.type === 'prefix') {
    // allow exact host (without trailing slash), any path under the prefix,
    // or a query/fragment directly after the host or path.
    const prefix = rule.value.replace(/\/+$/, '');
    return normalizedUrl === prefix
      || normalizedUrl.startsWith(prefix + '/')
      || normalizedUrl.startsWith(prefix + '?')
      || normalizedUrl.startsWith(prefix + '#');
  }

  if (rule.type === 'exact') {
    if (normalizedUrl === rule.value) {
      return true;
    }
    const strippedUrl = normalizedUrl.replace(/\/+$/, '');
    const strippedValue = rule.value.replace(/\/+$/, '');
    return strippedUrl === strippedValue;
  }

  return false;
}

class ModerationService {
  constructor(filePath = null) {
    this.filePath = filePath || null;
    this.chats = new Map();
    this._load();
  }

  _normalizeChat(chat = {}) {
    return {
      rules: normalizeTextPayload(chat.rules ?? 'Правила чата пока не настроены.'),
      greeting: normalizeTextPayload(chat.greeting ?? 'Добро пожаловать в чат! Ознакомьтесь с правилами через /rules.'),
      warnings: chat.warnings && typeof chat.warnings === 'object'
        ? Object.fromEntries(Object.entries(chat.warnings).map(([key, value]) => [String(key), Number(value)]))
        : {},
      filters: chat.filters && typeof chat.filters === 'object' ? { ...chat.filters } : {},
      banWords: Array.isArray(chat.banWords)
        ? [...new Set(chat.banWords.map((item) => String(item).trim().toLowerCase()).filter(Boolean))]
        : [...DEFAULT_BAN_WORDS],
      banwordSettings: {
        punishmentMode: ['off', 'warn', 'mute', 'ban'].includes(String(chat.banwordSettings?.punishmentMode || '').toLowerCase())
          ? String(chat.banwordSettings.punishmentMode).toLowerCase()
          : 'off',
        deleteMessages: Boolean(chat.banwordSettings?.deleteMessages),
      },
      warnSettings: {
        punishmentMode: ['off', 'warn', 'mute', 'ban', 'kick'].includes(String(chat.warnSettings?.punishmentMode || '').toLowerCase())
          ? String(chat.warnSettings.punishmentMode).toLowerCase()
          : 'off',
        warningLimit: (() => {
          const limit = Number(chat.warnSettings?.warningLimit);
          return Number.isFinite(limit) && limit >= 2 && limit <= 6 ? limit : 3;
        })(),
        blockDuration: (() => {
          const duration = Number(chat.warnSettings?.blockDuration);
          return Number.isFinite(duration) && duration > 0 ? duration : 24;
        })(),
      },
      allowedLinks: (() => {
        if (!Array.isArray(chat.allowedLinks)) {
          return [];
        }
        const chatList = chat.allowedLinks.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
        return [...new Set(chatList)];
      })(),
      allowedForwards: (() => {
        if (!Array.isArray(chat.allowedForwards)) {
          return [];
        }
        const forwardList = chat.allowedForwards.map((item) => String(item).trim()).filter(Boolean);
        return [...new Set(forwardList)];
      })(),
      menu: {
        enabled: chat.menu && typeof chat.menu.enabled === 'boolean' ? chat.menu.enabled : true,
        text: normalizeTextPayload((chat.menu && typeof chat.menu.text !== 'undefined')
          ? chat.menu.text
          : 'Спасибо за публикацию! Настройте первое сообщение бота через /menu.'),
        buttons: (() => {
          const rawButtons = chat.menu?.buttons;
          if (!Array.isArray(rawButtons)) {
            return [];
          }

          if (!rawButtons.length) {
            return [];
          }

          const firstItem = rawButtons[0];
          if (Array.isArray(firstItem)) {
            return rawButtons.map((row) => Array.isArray(row)
              ? row.filter((item) => item && typeof item.text === 'string' && typeof item.url === 'string')
              : []);
          }

          return [rawButtons.filter((item) => item && typeof item.text === 'string' && typeof item.url === 'string')];
        })(),
        media: (chat.menu && typeof chat.menu.media === 'object' && chat.menu.media !== null)
          ? { ...chat.menu.media }
          : null,
      },
      spamProtectionEnabled: Boolean(chat.spamProtectionEnabled),
      linkProtectionEnabled: Boolean(chat.linkProtectionEnabled),
      floodProtectionEnabled: Boolean(chat.floodProtectionEnabled),
      rulesEnabled: chat.rulesEnabled === undefined ? true : Boolean(chat.rulesEnabled),
      streaksEnabled: chat.streaksEnabled === undefined ? true : Boolean(chat.streaksEnabled),
      streaksLabel: typeof chat.streaksLabel === 'string' ? chat.streaksLabel.trim() || 'Серия' : 'Серия',
      chatAccessMode: ['open', 'closed', 'admins', 'owner'].includes(String(chat.chatAccessMode || '').toLowerCase())
        ? String(chat.chatAccessMode).toLowerCase()
        : 'open',
      captchaEnabled: chat.captchaEnabled === undefined ? true : Boolean(chat.captchaEnabled),
      captchaMode: chat.captchaMode || 'emoji',
      mediaAiEnabled: Boolean(chat.mediaAiEnabled),
      captchaTimeoutMinutes: Number.isFinite(Number(chat.captchaTimeoutMinutes)) ? Number(chat.captchaTimeoutMinutes) : 3,
      mentionNotifications: {
        enabled: chat.mentionNotifications?.enabled !== undefined ? Boolean(chat.mentionNotifications.enabled) : true,
      },
      adminNotify: {
        mode: (chat.adminNotify && typeof chat.adminNotify.mode === 'string') ? chat.adminNotify.mode : 'none',
        notifyOwner: Boolean(chat.adminNotify?.notifyOwner),
        notifyAdmins: Boolean(chat.adminNotify?.notifyAdmins),
        advanced: Boolean(chat.adminNotify?.advanced),
        onlyInReply: Boolean(chat.adminNotify?.onlyInReply),
        reasonRequired: Boolean(chat.adminNotify?.reasonRequired),
        deleteOnProcess: Boolean(chat.adminNotify?.deleteOnProcess),
        deleteInStaffGroup: Boolean(chat.adminNotify?.deleteInStaffGroup),
      },
      hideAnonymous: {
        enabled: Boolean(chat.hideAnonymous?.enabled),
        deleteMessages: Boolean(chat.hideAnonymous?.deleteMessages),
        allowedAnonymousChannels: (() => {
          const list = [];
          if (Array.isArray(chat.hideAnonymous?.allowedAnonymousChannels)) {
            list.push(...chat.hideAnonymous.allowedAnonymousChannels.map((item) => this._normalizeAnonymousChannelIdentifier(item)).filter(Boolean));
          }
          if (Array.isArray(chat.hideAnonymous?.allowedChannelIds)) {
            list.push(...chat.hideAnonymous.allowedChannelIds.map((item) => this._normalizeAnonymousChannelIdentifier(item)).filter(Boolean));
          }
          return [...new Set(list)];
        })(),
      },
      commandRights: (chat.commandRights && typeof chat.commandRights === 'object')
        ? { ...chat.commandRights }
        : {},
      commandDisabled: (chat.commandDisabled && typeof chat.commandDisabled === 'object')
        ? { ...chat.commandDisabled }
        : {},
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
    return normalizeTextPayload(this._getChat(chatId).rules).text;
  }

  getRulesPayload(chatId) {
    return normalizeTextPayload(this._getChat(chatId).rules);
  }

  setRules(chatId, rules) {
    this._getChat(chatId).rules = normalizeTextPayload(rules);
    this._save();
  }

  getGreeting(chatId) {
    return normalizeTextPayload(this._getChat(chatId).greeting).text;
  }

  getGreetingPayload(chatId) {
    return normalizeTextPayload(this._getChat(chatId).greeting);
  }

  setGreeting(chatId, greeting) {
    this._getChat(chatId).greeting = normalizeTextPayload(greeting);
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

  getAllWarnings(chatId) {
    const warnings = this._getChat(chatId).warnings;
    return Object.entries(warnings)
      .filter(([, count]) => Number(count) > 0)
      .sort(([, a], [, b]) => Number(b) - Number(a));
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

  enableMediaAi(chatId) {
    this._getChat(chatId).mediaAiEnabled = true;
    this._save();
  }

  disableMediaAi(chatId) {
    this._getChat(chatId).mediaAiEnabled = false;
    this._save();
  }

  isMediaAiEnabled(chatId) {
    return Boolean(this._getChat(chatId).mediaAiEnabled);
  }

  enableRules(chatId) {
    this._getChat(chatId).rulesEnabled = true;
    this._save();
  }

  disableRules(chatId) {
    this._getChat(chatId).rulesEnabled = false;
    this._save();
  }

  isRulesEnabled(chatId) {
    return this._getChat(chatId).rulesEnabled !== false;
  }

  enableStreaks(chatId) {
    this._getChat(chatId).streaksEnabled = true;
    this._save();
    return true;
  }

  disableStreaks(chatId) {
    this._getChat(chatId).streaksEnabled = false;
    this._save();
    return true;
  }

  isStreaksEnabled(chatId) {
    return this._getChat(chatId).streaksEnabled !== false;
  }

  setStreaksLabel(chatId, label) {
    const text = String(label || '').trim();
    this._getChat(chatId).streaksLabel = text || 'Серия';
    this._save();
    return true;
  }

  getStreaksLabel(chatId) {
    return this._getChat(chatId).streaksLabel || 'Серия';
  }

  setChatAccessMode(chatId, mode) {
    const normalized = String(mode || '').trim().toLowerCase();
    if (!['open', 'closed', 'admins', 'owner'].includes(normalized)) {
      return false;
    }

    this._getChat(chatId).chatAccessMode = normalized;
    this._save();
    return true;
  }

  getChatAccessMode(chatId) {
    const mode = String(this._getChat(chatId).chatAccessMode || '').trim().toLowerCase();
    return ['open', 'closed', 'admins', 'owner'].includes(mode) ? mode : 'open';
  }

  canWriteInChat(chatId, userId, isOwner = false, isGroupAdmin = false) {
    const mode = this.getChatAccessMode(chatId);
    const ownerFlag = Boolean(isOwner);
    const adminFlag = Boolean(isGroupAdmin);

    if (mode === 'open') {
      return true;
    }

    if (mode === 'closed') {
      return false;
    }

    if (mode === 'admins') {
      return ownerFlag || adminFlag;
    }

    if (mode === 'owner') {
      return ownerFlag;
    }

    return true;
  }

  enableCaptcha(chatId) {
    this._getChat(chatId).captchaEnabled = true;
    this._save();
  }

  disableCaptcha(chatId) {
    this._getChat(chatId).captchaEnabled = false;
    this._save();
  }

  isCaptchaEnabled(chatId) {
    return this._getChat(chatId).captchaEnabled !== false;
  }

  setCaptchaMode(chatId, mode) {
    const normalized = String(mode || '').trim().toLowerCase();
    const allowedModes = ['emoji', 'math', 'color', 'word'];
    if (!allowedModes.includes(normalized)) {
      return false;
    }
    this._getChat(chatId).captchaMode = normalized;
    this._save();
    return true;
  }

  getCaptchaMode(chatId) {
    return this._getChat(chatId).captchaMode || 'emoji';
  }

  setCaptchaTimeoutMinutes(chatId, minutes) {
    const parsed = Number(minutes);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return false;
    }
    this._getChat(chatId).captchaTimeoutMinutes = parsed;
    this._save();
    return true;
  }

  getCaptchaTimeoutMinutes(chatId) {
    const parsed = Number(this._getChat(chatId).captchaTimeoutMinutes);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
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

  getBanwordPunishmentMode(chatId) {
    return this._getChat(chatId).banwordSettings.punishmentMode || 'off';
  }

  setBanwordPunishmentMode(chatId, mode) {
    const normalized = String(mode || '').trim().toLowerCase();
    if (!['off', 'warn', 'mute', 'ban'].includes(normalized)) {
      return false;
    }
    this._getChat(chatId).banwordSettings.punishmentMode = normalized;
    this._save();
    return true;
  }

  getBanwordDeleteMessages(chatId) {
    return Boolean(this._getChat(chatId).banwordSettings.deleteMessages);
  }

  setBanwordDeleteMessages(chatId, enabled) {
    this._getChat(chatId).banwordSettings.deleteMessages = Boolean(enabled);
    this._save();
    return this._getChat(chatId).banwordSettings.deleteMessages;
  }

  getWarnPunishmentMode(chatId) {
    return this._getChat(chatId).warnSettings.punishmentMode || 'off';
  }

  setWarnPunishmentMode(chatId, mode) {
    const normalized = String(mode || '').trim().toLowerCase();
    if (!['off', 'warn', 'mute', 'ban', 'kick'].includes(normalized)) {
      return false;
    }
    this._getChat(chatId).warnSettings.punishmentMode = normalized;
    this._save();
    return true;
  }

  getWarnLimit(chatId) {
    return this._getChat(chatId).warnSettings.warningLimit || 3;
  }

  setWarnLimit(chatId, limit) {
    const normalized = Number(limit);
    if (!Number.isFinite(normalized) || normalized < 2 || normalized > 6) {
      return false;
    }
    this._getChat(chatId).warnSettings.warningLimit = normalized;
    this._save();
    return true;
  }

  getWarnBlockDuration(chatId) {
    const duration = this._getChat(chatId).warnSettings.blockDuration;
    return typeof duration === 'number' ? duration : 24;
  }

  setWarnBlockDuration(chatId, hours) {
    const normalized = Number(hours);
    if (!Number.isFinite(normalized) || normalized < 0) {
      return false;
    }
    this._getChat(chatId).warnSettings.blockDuration = normalized;
    this._save();
    return true;
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
    const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-zа-я0-9]/g, '');
    const compressRepeated = (value) => value.replace(/(.)\1+/g, '$1');
    const commonSuffixes = [
      'ться', 'тся', 'уть', 'усь', 'ать', 'ять', 'ить', 'ыы', 'я', 'и', 'а', 'е', 'о', 'ы', 'ь',
      'ов', 'ев', 'овка', 'овый', 'овой', 'ник', 'чик', 'щик', 'ка', 'ча', 'ный', 'ние', 'ание', 'ение'
    ];
    const explicitVariantChecks = [
      ['self-harm', 'selfharm'],
      ['селфхарм', 'selfharm'],
      ['selfharm', 'self-harm'],
      ['self-harm', 'sel f harm'],
    ];

    const buildComparisonValues = (value) => {
      const source = normalize(value);
      if (!source) {
        return [];
      }

      const values = new Set();
      const forms = [source, compressRepeated(source)];
      forms.forEach((candidate) => {
        if (!candidate || candidate.length < 3) {
          return;
        }
        values.add(candidate);
        for (const suffix of commonSuffixes) {
          if (candidate.length > suffix.length + 2 && candidate.endsWith(suffix)) {
            values.add(candidate.slice(0, -suffix.length));
          }
        }
      });

      return [...values].filter((candidate) => candidate.length >= 3);
    };

    const textValues = new Set();
    const rawText = String(text || '').toLowerCase();
    const textTokens = rawText.match(/[a-zа-я0-9]+/g) || [];
    for (const [primary, alternate] of explicitVariantChecks) {
      const primaryText = normalize(rawText);
      const alternateText = normalize(alternate);
      if (primaryText.includes(primary) || primaryText.includes(alternateText) || rawText.includes(primary) || rawText.includes(alternate)) {
        return primary;
      }
    }
    if (!textTokens.length) {
      return null;
    }
    textTokens.forEach((token) => {
      buildComparisonValues(token).forEach((candidate) => textValues.add(candidate));
    });

    const wholeText = normalize(rawText);
    if (wholeText) {
      buildComparisonValues(wholeText).forEach((candidate) => textValues.add(candidate));
    }

    let bestMatch = null;
    let bestScore = -1;

    for (const word of this._getChat(chatId).banWords) {
      const normalizedWord = normalize(word);
      if (!normalizedWord) {
        continue;
      }

      const wordValues = buildComparisonValues(normalizedWord);
      let wordBestScore = -1;

      for (const candidate of wordValues) {
        for (const textCandidate of textValues) {
          if (!textCandidate || !candidate) {
            continue;
          }

          if (textCandidate === candidate || textCandidate.includes(candidate) || candidate.includes(textCandidate)) {
            const score = candidate.length + (textCandidate === candidate ? 10 : 0);
            if (score > wordBestScore) {
              wordBestScore = score;
            }
          }
        }
      }

      if (wordBestScore > bestScore) {
        bestMatch = word;
        bestScore = wordBestScore;
      }
    }

    return bestMatch;
  }

  getAllowedLinks(chatId) {
    return [...this._getChat(chatId).allowedLinks];
  }

  addAllowedLink(chatId, value) {
    const chat = this._getChat(chatId);
    const normalized = normalizeAllowedUrl(value);
    if (!normalized || chat.allowedLinks.includes(normalized)) {
      return false;
    }
    chat.allowedLinks.push(normalized);
    this._save();
    return true;
  }

  removeAllowedLink(chatId, value) {
    const chat = this._getChat(chatId);
    const normalized = normalizeAllowedUrl(value);
    const before = chat.allowedLinks.length;
    chat.allowedLinks = chat.allowedLinks.filter((item) => item !== normalized);
    if (chat.allowedLinks.length === before) {
      return false;
    }
    this._save();
    return true;
  }

  clearAllowedLinks(chatId) {
    const chat = this._getChat(chatId);
    if (chat.allowedLinks.length === 0) {
      return false;
    }
    chat.allowedLinks = [];
    this._save();
    return true;
  }

  getAllowedForwards(chatId) {
    return [...this._getChat(chatId).allowedForwards];
  }

  addAllowedForward(chatId, value) {
    const chat = this._getChat(chatId);
    const normalized = String(value || '').trim();
    if (!normalized || chat.allowedForwards.includes(normalized)) {
      return false;
    }
    chat.allowedForwards.push(normalized);
    this._save();
    return true;
  }

  removeAllowedForward(chatId, value) {
    const chat = this._getChat(chatId);
    const normalized = String(value || '').trim();
    const before = chat.allowedForwards.length;
    chat.allowedForwards = chat.allowedForwards.filter((item) => item !== normalized);
    if (chat.allowedForwards.length === before) {
      return false;
    }
    this._save();
    return true;
  }

  clearAllowedForwards(chatId) {
    const chat = this._getChat(chatId);
    if (chat.allowedForwards.length === 0) {
      return false;
    }
    chat.allowedForwards = [];
    this._save();
    return true;
  }

  formatTextWithLinks(text) {
    if (text && typeof text === 'object' && !Array.isArray(text)) {
      const source = String(text.text ?? '');
      const entities = Array.isArray(text.entities) ? text.entities.map((entity) => ({ ...entity })) : [];
      return { text: source, entities };
    }

    const source = String(text ?? '');
    if (!source) {
      return { text: '', entities: [] };
    }

    const entities = [];
    let result = '';
    let lastIndex = 0;
    const patterns = [
      /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|www\.[^\s)]+)\)/g,
      /([^\n()]+?)\((https?:\/\/[^\s)]+|www\.[^\s)]+)\)/g,
    ];

    for (const pattern of patterns) {
      const matches = Array.from(source.matchAll(pattern));
      if (!matches.length) {
        continue;
      }

      for (const match of matches) {
        const [fullMatch, label, url] = match;
        const startIndex = match.index || 0;
        result += source.slice(lastIndex, startIndex);
        const normalizedLabel = String(label || '').trim();
        const normalizedUrl = String(url || '').trim();
        if (!normalizedLabel) {
          result += fullMatch;
        } else {
          const urlValue = normalizedUrl.startsWith('http://') || normalizedUrl.startsWith('https://')
            ? normalizedUrl
            : `https://${normalizedUrl}`;
          const offset = result.length;
          result += normalizedLabel;
          entities.push({ offset, length: normalizedLabel.length, type: 'text_link', url: urlValue });
        }
        lastIndex = startIndex + fullMatch.length;
      }
      break;
    }

    result += source.slice(lastIndex);
    return { text: result, entities };
  }

  getMenuEnabled(chatId) {
    return Boolean(this._getChat(chatId).menu.enabled !== false);
  }

  enableMenu(chatId) {
    this._getChat(chatId).menu.enabled = true;
    this._save();
    return true;
  }

  disableMenu(chatId) {
    this._getChat(chatId).menu.enabled = false;
    this._save();
    return true;
  }

  getMenuText(chatId) {
    return normalizeTextPayload(this._getChat(chatId).menu.text).text;
  }

  getMenuTextPayload(chatId) {
    return normalizeTextPayload(this._getChat(chatId).menu.text);
  }

  setMenuText(chatId, text) {
    this._getChat(chatId).menu.text = normalizeTextPayload(text);
    this._save();
    return true;
  }

  getMenuButtons(chatId) {
    const buttons = this._getChat(chatId).menu.buttons || [];
    return buttons.map((row) => row.map((item) => ({ ...item })));
  }

  isMentionNotificationsEnabled(chatId) {
    return Boolean(this._getChat(chatId).mentionNotifications?.enabled !== false);
  }

  setMentionNotificationsEnabled(chatId, enabled) {
    this._getChat(chatId).mentionNotifications.enabled = Boolean(enabled);
    this._save();
    return true;
  }

  getAdminNotifyMode(chatId) {
    return String(this._getChat(chatId).adminNotify.mode || 'none');
  }

  setAdminNotifyMode(chatId, mode) {
    const allowed = ['none', 'owner', 'staff'];
    if (!allowed.includes(String(mode))) {
      return false;
    }
    this._getChat(chatId).adminNotify.mode = String(mode);
    this._save();
    return true;
  }

  getAdminNotifyOwner(chatId) {
    return Boolean(this._getChat(chatId).adminNotify.notifyOwner);
  }

  setAdminNotifyOwner(chatId, enabled) {
    this._getChat(chatId).adminNotify.notifyOwner = Boolean(enabled);
    this._save();
    return true;
  }

  getAdminNotifyAdmins(chatId) {
    return Boolean(this._getChat(chatId).adminNotify.notifyAdmins);
  }

  setAdminNotifyAdmins(chatId, enabled) {
    this._getChat(chatId).adminNotify.notifyAdmins = Boolean(enabled);
    this._save();
    return true;
  }

  getAdminNotifyAdvanced(chatId) {
    return Boolean(this._getChat(chatId).adminNotify.advanced);
  }

  setAdminNotifyAdvanced(chatId, enabled) {
    this._getChat(chatId).adminNotify.advanced = Boolean(enabled);
    this._save();
    return true;
  }

  getAdminNotifyOnlyInReply(chatId) {
    return Boolean(this._getChat(chatId).adminNotify.onlyInReply);
  }

  setAdminNotifyOnlyInReply(chatId, enabled) {
    this._getChat(chatId).adminNotify.onlyInReply = Boolean(enabled);
    this._save();
    return true;
  }

  getAdminNotifyReasonRequired(chatId) {
    return Boolean(this._getChat(chatId).adminNotify.reasonRequired);
  }

  setAdminNotifyReasonRequired(chatId, enabled) {
    this._getChat(chatId).adminNotify.reasonRequired = Boolean(enabled);
    this._save();
    return true;
  }

  getAdminNotifyDeleteOnProcess(chatId) {
    return Boolean(this._getChat(chatId).adminNotify.deleteOnProcess);
  }

  setAdminNotifyDeleteOnProcess(chatId, enabled) {
    this._getChat(chatId).adminNotify.deleteOnProcess = Boolean(enabled);
    this._save();
    return true;
  }

  getAdminNotifyDeleteInStaffGroup(chatId) {
    return Boolean(this._getChat(chatId).adminNotify.deleteInStaffGroup);
  }

  setAdminNotifyDeleteInStaffGroup(chatId, enabled) {
    this._getChat(chatId).adminNotify.deleteInStaffGroup = Boolean(enabled);
    this._save();
    return true;
  }

  addMenuRow(chatId) {
    const chat = this._getChat(chatId);
    chat.menu.buttons = chat.menu.buttons || [];
    chat.menu.buttons.push([]);
    this._save();
    return true;
  }

  removeMenuRow(chatId, rowIndex) {
    const chat = this._getChat(chatId);
    const rows = Array.isArray(chat.menu.buttons) ? chat.menu.buttons : [];
    if (rowIndex < 0 || rowIndex >= rows.length) {
      return false;
    }
    rows.splice(rowIndex, 1);
    chat.menu.buttons = rows;
    this._save();
    return true;
  }

  addMenuButton(chatId, title, url, rowIndex = null) {
    const chat = this._getChat(chatId);
    const text = String(title || '').trim();
    const link = String(url || '').trim();
    if (!text || !link) {
      return false;
    }
    chat.menu.buttons = chat.menu.buttons || [];
    if (!Array.isArray(chat.menu.buttons)) {
      chat.menu.buttons = [];
    }
    if (rowIndex === null || rowIndex === undefined) {
      if (!chat.menu.buttons.length) {
        chat.menu.buttons.push([]);
      }
      rowIndex = chat.menu.buttons.length - 1;
    }
    if (!Array.isArray(chat.menu.buttons[rowIndex])) {
      return false;
    }
    chat.menu.buttons[rowIndex].push({ text, url: link });
    this._save();
    return true;
  }

  removeMenuButton(chatId, rowIndex, buttonIndex) {
    const chat = this._getChat(chatId);
    const rows = Array.isArray(chat.menu.buttons) ? chat.menu.buttons : [];
    if (rowIndex < 0 || rowIndex >= rows.length) {
      return false;
    }
    const row = rows[rowIndex];
    if (!Array.isArray(row) || buttonIndex < 0 || buttonIndex >= row.length) {
      return false;
    }
    row.splice(buttonIndex, 1);
    chat.menu.buttons = rows;
    this._save();
    return true;
  }

  clearMenuButtons(chatId) {
    this._getChat(chatId).menu.buttons = [];
    this._save();
    return true;
  }

  getMenuMedia(chatId) {
    return this._getChat(chatId).menu.media;
  }

  setMenuMedia(chatId, media) {
    if (!media || typeof media !== 'object' || !media.type || !media.fileId) {
      return false;
    }
    this._getChat(chatId).menu.media = {
      type: String(media.type),
      fileId: String(media.fileId),
    };
    this._save();
    return true;
  }

  clearMenuMedia(chatId) {
    this._getChat(chatId).menu.media = null;
    this._save();
    return true;
  }

  isAllowedLink(chatId, value) {
    const normalizedValue = String(value || '').trim().toLowerCase();
    if (!normalizedValue) {
      return false;
    }

    const normalizedUrl = normalizeAllowedUrl(normalizedValue);
    if (!normalizedUrl) {
      return false;
    }

    return this._getChat(chatId).allowedLinks.some((item) => {
      const rule = parseAllowedLinkRule(item);
      return matchesAllowedRule(rule, normalizedUrl);
    });
  }

  _normalizeAnonymousChannelIdentifier(value) {
    if (value === null || value === undefined) {
      return '';
    }

    const raw = String(value).trim();
    if (!raw) {
      return '';
    }

    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      return String(numeric);
    }

    let username = raw.replace(/^https?:\/\//i, '');
    username = username.replace(/^www\./i, '');
    username = username.replace(/^t\.me\//i, '');
    username = username.replace(/^telegram\.me\//i, '');
    username = username.replace(/^@/, '');
    username = username.replace(/[?#].*$/, '');
    username = username.replace(/\/+$/, '');
    username = username.trim().toLowerCase();
    return username;
  }

  isHideAnonymousEnabled(chatId) {
    return Boolean(this._getChat(chatId).hideAnonymous.enabled);
  }

  enableHideAnonymous(chatId) {
    this._getChat(chatId).hideAnonymous.enabled = true;
    this._save();
  }

  disableHideAnonymous(chatId) {
    this._getChat(chatId).hideAnonymous.enabled = false;
    this._save();
  }

  shouldDeleteAnonymousMessages(chatId) {
    return Boolean(this._getChat(chatId).hideAnonymous.deleteMessages);
  }

  enableDeleteAnonymousMessages(chatId) {
    this._getChat(chatId).hideAnonymous.deleteMessages = true;
    this._save();
  }

  getAllowedAnonymousChannels(chatId) {
    return [...this._getChat(chatId).hideAnonymous.allowedAnonymousChannels];
  }

  addAllowedAnonymousChannel(chatId, channelId) {
    const chat = this._getChat(chatId);
    const normalized = this._normalizeAnonymousChannelIdentifier(channelId);
    if (!normalized || chat.hideAnonymous.allowedAnonymousChannels.includes(normalized)) {
      return false;
    }
    chat.hideAnonymous.allowedAnonymousChannels.push(normalized);
    this._save();
    return true;
  }

  removeAllowedAnonymousChannel(chatId, channelId) {
    const chat = this._getChat(chatId);
    const normalized = this._normalizeAnonymousChannelIdentifier(channelId);
    const before = chat.hideAnonymous.allowedAnonymousChannels.length;
    chat.hideAnonymous.allowedAnonymousChannels = chat.hideAnonymous.allowedAnonymousChannels.filter((item) => item !== normalized);
    if (chat.hideAnonymous.allowedAnonymousChannels.length === before) {
      return false;
    }
    this._save();
    return true;
  }

  isAllowedAnonymousChannel(chatId, channel) {
    const chat = this._getChat(chatId);
    const normalized = new Set(chat.hideAnonymous.allowedAnonymousChannels || []);
    if (!normalized.size) {
      return false;
    }

    if (channel && typeof channel === 'object') {
      const id = channel.id;
      const username = channel.username;
      if (Number.isFinite(Number(id)) && normalized.has(String(id))) {
        return true;
      }
      if (typeof username === 'string' && normalized.has(this._normalizeAnonymousChannelIdentifier(username))) {
        return true;
      }
      return false;
    }

    const identifier = this._normalizeAnonymousChannelIdentifier(channel);
    return Boolean(identifier && normalized.has(identifier));
  }

  disableDeleteAnonymousMessages(chatId) {
    this._getChat(chatId).hideAnonymous.deleteMessages = false;
    this._save();
  }

  getCommandRights(chatId, command) {
    const chat = this._getChat(chatId);
    const cmd = String(command || '').toLowerCase().replace(/^\//, '');
    return chat.commandRights[cmd] || 'all';
  }

  setCommandRights(chatId, command, level) {
    const chat = this._getChat(chatId);
    const cmd = String(command || '').toLowerCase().replace(/^\//, '');
    if (['all', 'admin', 'none'].includes(level)) {
      chat.commandRights[cmd] = level;
      this._save();
      return true;
    }
    return false;
  }

  getAllCommandRights(chatId) {
    return { ...this._getChat(chatId).commandRights };
  }

  isCommandDisabled(chatId, command) {
    const chat = this._getChat(chatId);
    const cmd = String(command || '').toLowerCase().replace(/^\//, '');
    return Boolean(chat.commandDisabled[cmd]);
  }

  setCommandDisabled(chatId, command, disabled) {
    const chat = this._getChat(chatId);
    const cmd = String(command || '').toLowerCase().replace(/^\//, '');
    if (disabled) {
      chat.commandDisabled[cmd] = true;
    } else {
      delete chat.commandDisabled[cmd];
    }
    this._save();
    return true;
  }

  getAllCommandDisabled(chatId) {
    return { ...this._getChat(chatId).commandDisabled };
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
