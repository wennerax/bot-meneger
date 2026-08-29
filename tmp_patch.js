const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'app', 'services', 'database.js');
let content = fs.readFileSync(filePath, 'utf8');

// Patch 1: Add createdAt to recordMessage
const recordMessageFind = `    this.data.groupUsers[id][user] = {
      chatId: id,
      userId: user,
      username: normalizedUsername,
      displayName,
      lastSeenAt: this._now(),
    };

    if (!this.data.messageCounts[id]) {`;

const recordMessageReplace = `    this.data.groupUsers[id][user] = {
      chatId: id,
      userId: user,
      username: normalizedUsername,
      displayName,
      lastSeenAt: this._now(),
    };

    // Preserve createdAt on update, set it on first record
    const existing = this.data.groupUsers[id][user];
    if (!existing.createdAt) {
      existing.createdAt = this._now();
    }

    if (!this.data.messageCounts[id]) {`;

content = content.replace(recordMessageFind, recordMessageReplace);

// Patch 2: Add createdAt to getUserProfile return
const getUserProfileFind = `    return {
      userId: user,
      displayName: userData?.displayName || null,
      username: userData?.username ? \`@\${userData.username}\` : null,
      description: this.data.userDescriptions[id]?.[user] || null,
      messageCount,
      streak,
      streakBadge: premiumEmojis.getStreakBadge(streak),
      topPosition: topPosition > 0 ? topPosition : null,
      punishments: mergedPunishments,
      lastSeenAt: userData?.lastSeenAt || null,
    };
  }

  topMessages(chatId, limit = 10) {`;

const getUserProfileReplace = `    return {
      userId: user,
      displayName: userData?.displayName || null,
      username: userData?.username ? \`@\${userData.username}\` : null,
      description: this.data.userDescriptions[id]?.[user] || null,
      messageCount,
      streak,
      streakBadge: premiumEmojis.getStreakBadge(streak),
      topPosition: topPosition > 0 ? topPosition : null,
      punishments: mergedPunishments,
      lastSeenAt: userData?.lastSeenAt || null,
      createdAt: userData?.createdAt || null,
    };
  }

  topMessages(chatId, limit = 10) {`;

content = content.replace(getUserProfileFind, getUserProfileReplace);

fs.writeFileSync(filePath, content, 'utf8');
console.log('Patches applied successfully');
