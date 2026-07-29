class UserService {
  constructor() {
    this.userIds = new Set();
  }

  register(userId) {
    const id = Number(userId);
    if (this.userIds.has(id)) {
      return false;
    }

    this.userIds.add(id);
    return true;
  }

  get count() {
    return this.userIds.size;
  }
}

module.exports = UserService;
