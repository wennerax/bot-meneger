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
    botName: merged.BOT_NAME || 'Telegram Bot Manager',
    databasePath: merged.DATABASE_PATH || 'data/bot.json',
    ticketUrl1: merged.TICKET_URL_1 || merged.TICKET_URL1 || merged.TICKETS_URL_1 || merged.TICKETS_URL1 || '',
    ticketUrl2: merged.TICKET_URL_2 || merged.TICKET_URL2 || merged.TICKETS_URL_2 || merged.TICKETS_URL2 || '',
    chatUrl: merged.CHAT_URL || merged.TELEGRAM_CHAT_URL || merged.GROUP_CHAT_URL || '',
    rulesUrl: merged.RULES_URL || merged.RULES_LINK || '',
    siteUrl: merged.SITE_URL || merged.WEBSITE_URL || merged.SITE_LINK || '',
    miniAppUrl: merged.MINIAPP_URL || merged.MINI_APP_URL || merged.APP_URL || '',
    // Support generic AI provider env and OpenRouter-specific env names.
    aiApiKey,
    aiModel: merged.AI_MODEL || merged.OPENROUTER_MODEL || 'gpt-4o-mini',
    aiApiBaseUrl: merged.OPENROUTER_API_BASE_URL || merged.AI_API_BASE_URL || 'https://api.openrouter.ai',
    weatherLocation: merged.WEATHER_LOCATION || 'Moscow',
  };
}

function normalizePublicUrl(value) {
  const url = String(value || '').trim();
  if (!url) {
    return '';
  }

  return url.replace(/\/$/, '');
}

function getMiniAppPort() {
  const port = Number(process.env.MINIAPP_PORT || process.env.PORT || 3000);
  return Number.isFinite(port) && port > 0 ? port : 3000;
}

function detectPublicMiniAppUrl(config = {}, portNumber) {
  const env = process.env;
  const explicit = normalizePublicUrl(config.miniAppUrl || config.siteUrl);
  if (explicit) {
    return explicit;
  }

  const candidates = [
    env.MINIAPP_URL,
    env.MINI_APP_URL,
    env.APP_URL,
    env.WEBSITE_URL,
    env.SITE_URL,
    env.SITE_LINK,
    env.URL,
  ]
    .map(normalizePublicUrl)
    .filter(Boolean);

  if (env.VERCEL_URL) {
    candidates.unshift(`https://${normalizePublicUrl(env.VERCEL_URL)}`);
  }

  if (env.RENDER_EXTERNAL_HOSTNAME) {
    candidates.unshift(`https://${normalizePublicUrl(env.RENDER_EXTERNAL_HOSTNAME)}`);
  }

  if (env.WEBSITE_HOSTNAME) {
    candidates.unshift(`https://${normalizePublicUrl(env.WEBSITE_HOSTNAME)}`);
  }

  if (env.HEROKU_APP_NAME) {
    candidates.unshift(`https://${normalizePublicUrl(env.HEROKU_APP_NAME)}.herokuapp.com`);
  }

  if (env.HOST) {
    candidates.push(`http://${normalizePublicUrl(env.HOST)}`);
  }

  if (env.HOSTNAME && env.GITHUB_ACTIONS !== 'true') {
    candidates.push(`http://${normalizePublicUrl(env.HOSTNAME)}`);
  }

  const firstCandidate = candidates.find(Boolean);
  if (firstCandidate) {
    return normalizePublicUrl(firstCandidate);
  }

  const port = Number(env.MINIAPP_PORT || env.PORT || portNumber || 3000);
  return `http://localhost:${Number.isFinite(port) && port > 0 ? port : 3000}`;
}

module.exports = {
  loadConfig,
  parseAdminIds,
  getMiniAppPort,
  detectPublicMiniAppUrl,
};
