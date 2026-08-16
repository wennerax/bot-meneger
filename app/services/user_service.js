const fs = require('node:fs');
const path = require('node:path');

class UserService {
  constructor(filePath = null) {
    this.filePath = filePath || null;
    this.userIds = new Set();
    this._load();
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
      const ids = Array.isArray(parsed.userIds) ? parsed.userIds : [];
      this.userIds = new Set(ids.map((item) => Number(item)).filter((item) => Number.isFinite(item)));
    } catch (error) {
      this.userIds = new Set();
    }
  }

  _save() {
    if (!this.filePath) {
      return;
    }

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify({ userIds: Array.from(this.userIds) }, null, 2));
  }

  register(userId) {
    const id = Number(userId);
    if (this.userIds.has(id)) {
      return false;
    }

    this.userIds.add(id);
    this._save();
    return true;
  }

  hasUser(userId) {
    const id = Number(userId);
    return Number.isFinite(id) && this.userIds.has(id);
  }

  get count() {
    return this.userIds.size;
  }
}

module.exports = UserService;
