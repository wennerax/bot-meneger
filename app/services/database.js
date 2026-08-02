const fs = require('node:fs');
const path = require('node:path');

class Database {
  constructor(filePath = 'data/bot.json') {
    this.filePath = filePath;
    this.data = this._load();
    this._ensureDir();
  }

  _ensureDir() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  _load() {
    if (!fs.existsSync(this.filePath)) {
      return this._emptyState();
    }

    const raw = fs.readFileSync(this.filePath, 'utf8');
    if (!raw.trim()) {
      return this._emptyState();
    }

    try {
      const parsed = JSON.parse(raw);

      // botAdmins used to be an array in older versions. Convert to an object mapping userId->level
      let botAdminsObj = {};
      if (Array.isArray(parsed.botAdmins)) {
        (parsed.botAdmins || []).forEach((entry) => {
          const id = Number(entry);
          if (!Number.isNaN(id)) {
            // default legacy level for existing entries: 5 (младший админ)
            botAdminsObj[id] = 5;
          }
        });
      } else {
        botAdminsObj = parsed.botAdmins || {};
      }

      return {
        groups: parsed.groups || {},
        groupAdmins: parsed.groupAdmins || {},
        botAdmins: botAdminsObj,

        punishments: parsed.punishments || [],
        activePunishments: parsed.activePunishments || [],
        blacklist: parsed.blacklist || [],
        messageCounts: parsed.messageCounts || {},
        groupUsers: parsed.groupUsers || {},
        userDescriptions: parsed.userDescriptions || {},
        dailyActivity: parsed.dailyActivity || {},
      };
    } catch (error) {
      return this._emptyState();
    }
  }

  _emptyState() {
    return {
      groups: {},
      groupAdmins: {},
      botAdmins: {},
      punishments: [],
      activePunishments: [],
      blacklist: [],
      messageCounts: {},
      groupUsers: {},
      userDescriptions: {},
      dailyActivity: {},
    };
  }

  _save() {
    this._ensureDir();
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  _now() {
    return new Date().toISOString();
  }

  ensureGroup(chatId, title, ownerId = null) {
    const id = Number(chatId);
    if (!this.data.groups[id]) {
      this.data.groups[id] = {
        chatId: id,
        title,
        ownerId: ownerId === null ? null : Number(ownerId),
        linkTrigger: 0,
        createdAt: this._now(),
      };
    } else {
      this.data.groups[id].title = title;
      if (ownerId !== null) {
        this.data.groups[id].ownerId = Number(ownerId);
      }
    }

    if (ownerId !== null) {
      // owner becomes admin with top level (1)
      this.addAdmin(id, Number(ownerId), 1);
      this.addBotAdmin(id, Number(ownerId), 1);
    }

    this._save();
  }

  addAdmin(chatId, userId, level = 5) {
    const id = Number(chatId);
    const user = Number(userId);
    const lvl = Number(level) || 5;
    if (!this.data.groupAdmins[id]) {
      this.data.groupAdmins[id] = {};
    }
    // store numeric level for the admin (1..5), lower = more privileges
    this.data.groupAdmins[id][user] = lvl;
    this._save();
  }

  isAdmin(chatId, userId, configuredAdmins = []) {
    const id = Number(chatId);
    const user = Number(userId);
    const configured = (configuredAdmins || []).map((item) => Number(item));
    if (configured.includes(user)) {
      return true;
    }

    const val = this.data.groupAdmins[id]?.[user];
    if (val === undefined || val === null) {
      return false;
    }
    // legacy boolean true -> treat as admin (default level)
    if (val === true) {
      return true;
    }
    const num = Number(val);
    return Number.isFinite(num) && num >= 1;
  }

  addBotAdmin(chatId, userId, level = 5) {
    const id = Number(chatId);
    const user = Number(userId);
    const lvl = Number(level) || 5;
    if (!this.data.botAdmins[id]) {
      this.data.botAdmins[id] = {};
    }
    this.data.botAdmins[id][user] = lvl;
    this._save();
  }

  removeBotAdmin(chatId, userId) {
    const id = Number(chatId);
    const user = Number(userId);
    if (!this.data.botAdmins[id]) {
      return false;
    }
    if (this.data.botAdmins[id][user] === undefined) {
      return false;
    }
    delete this.data.botAdmins[id][user];
    this._save();
    return true;
  }

  isPrimaryBotAdmin(chatId, userId) {
    const id = Number(chatId);
    const ownerId = this.data.groups[id]?.ownerId;
    return ownerId !== undefined && ownerId !== null && Number(ownerId) === Number(userId);
  }

  isBotAdmin(chatId, userId) {
    const id = Number(chatId);
    const user = Number(userId);
    if (this.isPrimaryBotAdmin(chatId, user)) {
      return true;
    }
    const val = this.data.botAdmins[id]?.[user];
    if (val === undefined || val === null) {
      // legacy: if botAdmins was an array, fallback handled in _load conversion
      return false;
    }
    // numeric level > 0 means admin
    const num = Number(val);
    return Number.isFinite(num) && num >= 1;
  }

  getPrimaryBotAdmin(chatId) {
    const id = Number(chatId);
    return this.data.groups[id]?.ownerId !== undefined && this.data.groups[id]?.ownerId !== null
      ? Number(this.data.groups[id].ownerId)
      : null;
  }

  getAuxiliaryBotAdmins(chatId) {
    const id = Number(chatId);
    const primaryAdminId = this.getPrimaryBotAdmin(id);
    const mapping = this.data.botAdmins[id] || {};
    return Object.keys(mapping).map((k) => Number(k)).filter((userId) => Number(userId) !== Number(primaryAdminId));
  }

  getBotAdmins(chatId) {
    const id = Number(chatId);
    const ownerId = this.data.groups[id]?.ownerId;
    const mapping = this.data.botAdmins[id] || {};
    const admins = Object.keys(mapping).map((k) => Number(k));
    if (ownerId !== undefined && ownerId !== null && !admins.includes(Number(ownerId))) {
      admins.unshift(Number(ownerId));
    } else if (ownerId !== undefined && ownerId !== null && admins.includes(Number(ownerId))) {
      // ensure primary is first in list
      const idx = admins.indexOf(Number(ownerId));
      if (idx > 0) {
        admins.splice(idx, 1);
        admins.unshift(Number(ownerId));
      }
    }
    return admins;
  }

  getBotAdminLevel(chatId, userId) {
    const id = Number(chatId);
    const user = Number(userId);
    if (this.isPrimaryBotAdmin(chatId, user)) {
      return 1;
    }
    const val = this.data.botAdmins[id]?.[user];
    if (val === undefined || val === null) {
      return null;
    }
    return Number(val);
  }

  getAdminLevel(chatId, userId) {
    const id = Number(chatId);
    const user = Number(userId);
    const val = this.data.groupAdmins[id]?.[user];
    if (val === undefined || val === null) {
      return null;
    }
    if (val === true) {
      return null; // legacy boolean, unspecified
    }
    return Number(val);
  }

  recordMessage(chatId, userId, displayName, username = null) {
    const id = Number(chatId);
    const user = Number(userId);
    const normalizedUsername = username ? username.trim().replace(/^@/, '').toLowerCase() : null;

    if (!this.data.groupUsers[id]) {
      this.data.groupUsers[id] = {};
    }

    this.data.groupUsers[id][user] = {
      chatId: id,
      userId: user,
      username: normalizedUsername,
      displayName,
      lastSeenAt: this._now(),
    };

    if (!this.data.messageCounts[id]) {
      this.data.messageCounts[id] = {};
    }

    if (!this.data.messageCounts[id][user]) {
      this.data.messageCounts[id][user] = { displayName, messageCount: 0 };
    }

    this.data.messageCounts[id][user].displayName = displayName;
    this.data.messageCounts[id][user].messageCount += 1;

    const dayKey = new Date().toISOString().slice(0, 10);
    if (!this.data.dailyActivity[id]) {
      this.data.dailyActivity[id] = {};
    }
    if (!this.data.dailyActivity[id][user]) {
      this.data.dailyActivity[id][user] = [];
    }

    const lastEntry = this.data.dailyActivity[id][user][this.data.dailyActivity[id][user].length - 1];
    if (lastEntry && lastEntry.day === dayKey) {
      lastEntry.count += 1;
    } else {
      this.data.dailyActivity[id][user].push({ day: dayKey, count: 1 });
    }

    this._save();
  }

  resolveUsername(chatId, username) {
    const id = Number(chatId);
    const target = String(username).trim().replace(/^@/, '').toLowerCase();
    const users = this.data.groupUsers[id] || {};
    const match = Object.values(users).find((item) => item.username === target);

    if (!match) {
      return null;
    }

    return { userId: match.userId, displayName: match.displayName };
  }

  setUserDescription(chatId, userId, description) {
    const id = Number(chatId);
    const user = Number(userId);
    if (!this.data.userDescriptions[id]) {
      this.data.userDescriptions[id] = {};
    }

    const cleaned = String(description || '').trim();
    if (!cleaned) {
      this.data.userDescriptions[id][user] = '';
    } else {
      this.data.userDescriptions[id][user] = cleaned;
    }

    this._save();
  }

  getUserProfile(chatId, userId) {
    const id = Number(chatId);
    const user = Number(userId);
    const userData = this.data.groupUsers[id]?.[user] || null;
    const counts = this.data.messageCounts[id]?.[user] || null;
    const punishments = this.data.punishments.filter((item) => item.chatId === id && item.userId === user);
    const activePunishments = this.data.activePunishments.filter((item) => item.chatId === id && item.userId === user);
    const sorted = Object.entries(this.data.messageCounts[id] || {})
      .map(([entryUserId, item]) => ({
        userId: Number(entryUserId),
        messageCount: item.messageCount,
      }))
      .sort((left, right) => right.messageCount - left.messageCount);

    const topPosition = sorted.findIndex((item) => item.userId === user) + 1;
    const messageCount = counts?.messageCount || 0;

    return {
      userId: user,
      displayName: userData?.displayName || null,
    username: userData?.username ? `@${userData.username}` : null,
    description: this.data.userDescriptions[id]?.[user] || null,
    messageCount,
    topPosition: topPosition > 0 ? topPosition : null,
    punishments: [...punishments, ...activePunishments],
    lastSeenAt: userData?.lastSeenAt || null,
    };
  }

  topMessages(chatId, limit = 10) {
    const id = Number(chatId);
    const counts = this.data.messageCounts[id] || {};
    return Object.entries(counts)
      .map(([userId, item]) => ({
        userId: Number(userId),
        displayName: item.displayName,
        messageCount: item.messageCount,
      }))
      .sort((left, right) => right.messageCount - left.messageCount)
      .slice(0, limit);
  }

  getUserActivity(chatId, userId, days = 7) {
    const id = Number(chatId);
    const user = Number(userId);
    const history = this.data.dailyActivity[id]?.[user] || [];
    const result = [];
    const today = new Date();

    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const date = new Date(today);
      date.setDate(today.getDate() - offset);
      const dayKey = date.toISOString().slice(0, 10);
      const entry = history.find((item) => item.day === dayKey);
      result.push({ day: dayKey, count: entry ? entry.count : 0 });
    }

    return result;
  }

  setLinkTrigger(chatId, enabled) {
    const id = Number(chatId);
    if (!this.data.groups[id]) {
      this.data.groups[id] = { chatId: id, title: String(id), ownerId: null, linkTrigger: 0, createdAt: this._now() };
    }
    this.data.groups[id].linkTrigger = enabled ? 1 : 0;
    this._save();
  }

  linkTriggerEnabled(chatId) {
    const id = Number(chatId);
    return Boolean(this.data.groups[id]?.linkTrigger);
  }

  addPunishment(chatId, userId, action, reason, untilAt = null) {
    this.data.punishments.push({
      chatId: Number(chatId),
      userId: Number(userId),
      action,
      reason,
      untilAt,
      createdAt: this._now(),
    });
    this._save();
  }

  addBlacklist(chatId, userId, reason) {
    const id = Number(chatId);
    const user = Number(userId);
    const existingIndex = this.data.blacklist.findIndex((item) => item.chatId === id && item.userId === user);
    const entry = { chatId: id, userId: user, reason, createdAt: this._now() };

    if (existingIndex >= 0) {
      this.data.blacklist[existingIndex] = entry;
    } else {
      this.data.blacklist.push(entry);
    }
    this._save();
  }

  removeBlacklist(chatId, userId) {
    const id = Number(chatId);
    const user = Number(userId);
    this.data.blacklist = this.data.blacklist.filter((item) => item.chatId !== id || item.userId !== user);
    this._save();
  }

  isBlacklisted(chatId, userId) {
    const id = Number(chatId);
    const user = Number(userId);
    return this.data.blacklist.some((item) => item.chatId === id && item.userId === user);
  }

  addActivePunishment(chatId, userId, action, reason, untilAt = null) {
    const id = Number(chatId);
    const user = Number(userId);
    const existingIndex = this.data.activePunishments.findIndex(
      (item) => item.chatId === id && item.userId === user && item.action === action
    );
    const entry = {
      chatId: id,
      userId: user,
      action,
      reason,
      untilAt: untilAt === null || untilAt === undefined ? null : Number(untilAt),
      createdAt: this._now(),
    };

    if (existingIndex >= 0) {
      this.data.activePunishments[existingIndex] = entry;
    } else {
      this.data.activePunishments.push(entry);
    }
    this._save();
  }

  removeActivePunishment(chatId, userId, action) {
    const id = Number(chatId);
    const user = Number(userId);
    this.data.activePunishments = this.data.activePunishments.filter(
      (item) => item.chatId !== id || item.userId !== user || item.action !== action
    );
    this._save();
  }

  getActivePunishments(chatId) {
    const id = Number(chatId);
    return this.data.activePunishments.filter((item) => item.chatId === id);
  }

  getAllActivePunishments() {
    return [...(this.data.activePunishments || [])];
  }

  findActivePunishment(chatId, userId, action) {
    const id = Number(chatId);
    const user = Number(userId);
    return this.data.activePunishments.find(
      (item) => item.chatId === id && item.userId === user && item.action === action
    ) || null;
  }

  close() {
    this._save();
  }
}

module.exports = Database;
