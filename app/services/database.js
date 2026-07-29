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
      return {
        groups: parsed.groups || {},
        groupAdmins: parsed.groupAdmins || {},
        punishments: parsed.punishments || [],
        blacklist: parsed.blacklist || [],
        messageCounts: parsed.messageCounts || {},
        groupUsers: parsed.groupUsers || {},
      };
    } catch (error) {
      return this._emptyState();
    }
  }

  _emptyState() {
    return {
      groups: {},
      groupAdmins: {},
      punishments: [],
      blacklist: [],
      messageCounts: {},
      groupUsers: {},
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

  isBlacklisted(chatId, userId) {
    const id = Number(chatId);
    const user = Number(userId);
    return this.data.blacklist.some((item) => item.chatId === id && item.userId === user);
  }

  close() {
    this._save();
  }
}

module.exports = Database;
