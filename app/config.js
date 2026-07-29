const fs = require('node:fs');
const path = require('node:path');

function parseAdminIds(value) {
  if (value === undefined || value === null || value === '') {
    return [];
  }

  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => Number(item)).filter((item) => Number.isFinite(item)))];
  }

  if (typeof value === 'number') {
    return [value];
  }

  return [...new Set(
    String(value)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item))
  )];
}

function readEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }

  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .reduce((acc, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        return acc;
      }

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex === -1) {
        return acc;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();
      acc[key] = value.replace(/^['"]|['"]$/g, '');
      return acc;
    }, {});
}

function loadConfig(overrides = {}, options = {}) {
  const rootDir = path.resolve(__dirname, '..');
  const envPath = options.filePath
    ? path.resolve(rootDir, options.filePath)
    : path.join(rootDir, '.env');
  const envFile = readEnvFile(envPath);
  const merged = { ...process.env, ...envFile, ...overrides };

  return {
    botToken: merged.BOT_TOKEN || '',
    adminIds: parseAdminIds(merged.ADMIN_IDS),
    botName: merged.BOT_NAME || 'Telegram Bot Manager',
    databasePath: merged.DATABASE_PATH || 'data/bot.json',
    aiApiKey: merged.AI_API_KEY || '',
    aiModel: merged.AI_MODEL || 'gpt-4o-mini',
    aiApiBaseUrl: merged.AI_API_BASE_URL || 'https://api.openai.com/v1',
  };
}

module.exports = {
  loadConfig,
  parseAdminIds,
};
