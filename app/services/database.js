const fs = require('node:fs');
const path = require('node:path');
const premiumEmojis = require('../premium_emojis');

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
      const normalizedBotAdmins = {};
      const rawBotAdmins = parsed.botAdmins || {};

      // Support multiple legacy formats: array of entries, or object map { userId: level }
      Object.entries(rawBotAdmins).forEach(([chatId, admins]) => {
        const id = String(chatId);
        normalizedBotAdmins[id] = {};

        if (Array.isArray(admins)) {
          admins.forEach((entry) => {
            if (typeof entry === 'number' || typeof entry === 'string') {
              normalizedBotAdmins[id][String(Number(entry))] = 1;
              return;
            }
            if (entry && typeof entry === 'object') {
              const userId = Number(entry.userId);
              const level = Number(entry.level) || 1;
              if (Number.isFinite(userId)) {
                normalizedBotAdmins[id][String(userId)] = level;
              }
            }
          });
          return;
        }

        // If it's already an object map like {"123":1}
        if (admins && typeof admins === 'object') {
          Object.entries(admins).forEach(([userKey, value]) => {
            const userId = Number(userKey);
            const level = Number(value) || 1;
            if (Number.isFinite(userId)) {
              normalizedBotAdmins[id][String(userId)] = level;
            }
          });
          return;
        }

        // Fallback: leave as empty map
      });

      return {
        groups: parsed.groups || {},
        groupAdmins: parsed.groupAdmins || {},
        botAdmins: normalizedBotAdmins,
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
      this.addAdmin(id, Number(ownerId));
      this.addBotAdmin(id, Number(ownerId), 1);
    }

    this._save();
  }

  addAdmin(chatId, userId) {
    const id = Number(chatId);
    const user = Number(userId);
    if (!this.data.groupAdmins[id]) {
      this.data.groupAdmins[id] = {};
    }
    this.data.groupAdmins[id][user] = true;
    this._save();
  }

  isAdmin(chatId, userId, configuredAdmins = []) {
    const id = Number(chatId);
    const user = Number(userId);
    const configured = (configuredAdmins || []).map((item) => Number(item));
    if (configured.includes(user)) {
      return true;
    }

    return Boolean(this.data.groupAdmins[id]?.[user]);
  }

  addBotAdmin(chatId, userId, level = 1) {
    const id = String(Number(chatId));
    const user = String(Number(userId));
    if (this.isPrimaryBotAdmin(id, Number(user))) {
      return;
    }

    const normalizedLevel = Number(level) || 1;
    if (!this.data.botAdmins[id]) {
      this.data.botAdmins[id] = {};
    }

    this.data.botAdmins[id][user] = normalizedLevel;
    this._save();
  }

  removeBotAdmin(chatId, userId) {
    const id = String(Number(chatId));
    const user = String(Number(userId));
    if (!this.data.botAdmins[id] || this.data.botAdmins[id][user] === undefined) {
      return false;
    }
    delete this.data.botAdmins[id][user];
    // cleanup empty object
    if (Object.keys(this.data.botAdmins[id]).length === 0) {
      delete this.data.botAdmins[id];
    }
    this._save();
    return true;
  }

  getBotAdminLevel(chatId, userId) {
    const id = String(Number(chatId));
    const user = String(Number(userId));
    const entry = this.data.botAdmins[id]?.[user];
    if (entry !== undefined) {
      return Number(entry);
    }
    return this.isPrimaryBotAdmin(id, Number(user)) ? 1 : null;
  }

  canManageBotAdmin(chatId, actorUserId, targetUserId) {
    const id = Number(chatId);
    const actorId = Number(actorUserId);
    const targetId = Number(targetUserId);
    const primaryAdminId = this.getPrimaryBotAdmin(id);

    if (actorId === targetId) {
      return false;
    }

    if (this.isPrimaryBotAdmin(id, actorId)) {
      return targetId !== Number(primaryAdminId);
    }

    const actorLevel = this.getBotAdminLevel(id, actorId);
    const targetLevel = this.getBotAdminLevel(id, targetId);

    if (!actorLevel || !targetLevel) {
      return false;
    }

    if (targetId === Number(primaryAdminId)) {
      return false;
    }

    if (Number(actorLevel) === 2) {
      return false;
    }

    // Lower numeric level = higher privileges (1 = owner). Actor can manage lower-rank admins only.
    return Number(actorLevel) < Number(targetLevel);
  }

  canPunishBotAdmin(chatId, actorUserId, targetUserId) {
    const id = Number(chatId);
    const actorId = Number(actorUserId);
    const targetId = Number(targetUserId);
    const primaryAdminId = this.getPrimaryBotAdmin(id);

    if (actorId === targetId) {
      return false;
    }

    if (targetId === Number(primaryAdminId)) {
      return false;
    }

    const actorLevel = this.getBotAdminLevel(id, actorId);
    const targetLevel = this.getBotAdminLevel(id, targetId);

    if (!actorLevel) {
      return false;
    }

    if (targetLevel === null || targetLevel === undefined) {
      return true;
    }

    // Lower numeric level = higher priority. An admin can punish only lower-priority admins.
    return Number(targetLevel) > Number(actorLevel);
  }

  isPrimaryBotAdmin(chatId, userId) {
    const id = Number(chatId);
    const ownerId = this.data.groups[id]?.ownerId;
    return ownerId !== undefined && ownerId !== null && Number(ownerId) === Number(userId);
  }

  isBotAdmin(chatId, userId) {
    const id = String(Number(chatId));
    const user = Number(userId);
    return this.isPrimaryBotAdmin(chatId, user) || Boolean(this.data.botAdmins[id] && this.data.botAdmins[id][String(user)] !== undefined);
  }

  getPrimaryBotAdmin(chatId) {
    const id = Number(chatId);
    return this.data.groups[id]?.ownerId !== undefined && this.data.groups[id]?.ownerId !== null
      ? Number(this.data.groups[id].ownerId)
      : null;
  }

  getAuxiliaryBotAdmins(chatId) {
    const id = String(Number(chatId));
    const primaryAdminId = this.getPrimaryBotAdmin(id);
    const map = this.data.botAdmins[id] || {};
    return Object.keys(map)
      .map((k) => Number(k))
      .filter((uid) => uid !== Number(primaryAdminId));
  }

  getBotAdmins(chatId) {
    const id = String(Number(chatId));
    const ownerId = this.data.groups[id]?.ownerId;
    const admins = Object.keys(this.data.botAdmins[id] || {}).map((k) => Number(k));
    if (ownerId !== undefined && ownerId !== null && !admins.includes(Number(ownerId))) {
      admins.unshift(Number(ownerId));
    }
    return admins;
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

  getUserStreak(chatId, userId) {
    const id = Number(chatId);
    const user = Number(userId);
    const history = this.data.dailyActivity[id]?.[user] || [];

    if (!history.length) {
      return 0;
    }

    const activeDates = [...new Set(history
      .filter((item) => Number(item.count) > 0)
      .map((item) => String(item.day)))]
      .sort();

    if (!activeDates.length) {
      return 0;
    }

    const todayKey = new Date().toISOString().slice(0, 10);
    const latestDayKey = activeDates[activeDates.length - 1];
    const latestDay = new Date(`${latestDayKey}T00:00:00Z`);
    const todayDate = new Date(`${todayKey}T00:00:00Z`);

    if (latestDay.getTime() < todayDate.getTime()) {
      return 0;
    }

    let streak = 0;
    let cursor = new Date(latestDay);

    while (true) {
      const dayKey = cursor.toISOString().slice(0, 10);
      const hasActivity = history.some((item) => item.day === dayKey && Number(item.count) > 0);
      if (!hasActivity) {
        break;
      }
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }

    return streak;
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
    const streak = this.getUserStreak(id, user);

    return {
      userId: user,
      displayName: userData?.displayName || null,
      username: userData?.username ? `@${userData.username}` : null,
      description: this.data.userDescriptions[id]?.[user] || null,
      messageCount,
      streak,
      streakBadge: premiumEmojis.getStreakBadge(streak),
      topPosition: topPosition > 0 ? topPosition : null,
      punishments: [...punishments, ...activePunishments],
      lastSeenAt: userData?.lastSeenAt || null,
    };
  }

  topMessages(chatId, limit = 10) {
    const id = Number(chatId);
    const counts = this.data.messageCounts[id] || {};
    return Object.entries(counts)
      .map(([userId, item]) => {
        const streak = this.getUserStreak(id, Number(userId));
        return {
          userId: Number(userId),
          displayName: item.displayName,
          messageCount: item.messageCount,
          streak,
          streakBadge: premiumEmojis.getStreakBadge(streak),
        };
      })
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

  clearUserPunishmentHistory(chatId, userId) {
    const id = Number(chatId);
    const user = Number(userId);

    this.data.punishments = this.data.punishments.filter(
      (entry) => !(entry.chatId === id && entry.userId === user)
    );
    this.data.activePunishments = this.data.activePunishments.filter(
      (entry) => !(entry.chatId === id && entry.userId === user)
    );
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
