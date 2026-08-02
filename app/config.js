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

  const isProduction = process.env.NODE_ENV === 'production';
  const shouldLoadEnvFile = Boolean(options.filePath) || !isProduction;
  const envFile = shouldLoadEnvFile ? readEnvFile(envPath) : {};

  if (isProduction && !options.filePath && fs.existsSync(envPath)) {
    console.warn('Production mode: ignoring .env file for secret configuration. Set BOT_TOKEN and other sensitive values via environment variables.');
  }

  const merged = { ...envFile, ...process.env, ...overrides };
  const aiApiKey = merged.OPENROUTER_API_KEY || merged.AI_API_KEY || '';

  return {
    botToken: merged.BOT_TOKEN || '',
    adminIds: parseAdminIds(merged.ADMIN_IDS),
  // Optional: ids allowed to call the /reload command (comma-separated)
  reloadAdminIds: parseAdminIds(merged.RELOAD_ADMIN_IDS),
  botName: merged.BOT_NAME || 'Telegram Bot Manager',
  databasePath: merged.DATABASE_PATH || 'data/bot.json',
  // Support generic AI provider env and OpenRouter-specific env names.
  aiApiKey,
  aiModel: merged.AI_MODEL || merged.OPENROUTER_MODEL || 'openrouter',
  aiApiBaseUrl: merged.OPENROUTER_API_BASE_URL || merged.AI_API_BASE_URL || 'https://api.openrouter.ai',
  weatherLocation: merged.WEATHER_LOCATION || 'Moscow',
  };
}

module.exports = {
  loadConfig,
  parseAdminIds,
};
