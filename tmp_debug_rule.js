const ModerationService = require('./app/services/moderation_service');
const svc = new ModerationService();

function normalizeAllowedUrl(value) {
  return String(value || '').trim().toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/#.*$/, '');
}

function parseAllowedLinkRule(item) {
  const normalized = normalizeAllowedUrl(item);
  if (!normalized) return null;
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
      return hasTrailingSlash
        ? { type: 'prefix', value: `${host}/` }
        : { type: 'exact', value: host };
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
  } catch (err) {
    return { type: 'substring', value: normalized };
  }
}

function matchesAllowedRule(rule, normalizedUrl) {
  if (!rule || !rule.value || !normalizedUrl) return false;
  if (rule.type === 'substring') return normalizedUrl.includes(rule.value);
  if (rule.type === 'host') {
    const hostname = normalizedUrl.split('/')[0];
    return hostname === rule.value;
  }
  if (rule.type === 'prefix') {
    const prefix = rule.value.replace(/\/+$/, '');
    return normalizedUrl === prefix || normalizedUrl.startsWith(prefix + '/');
  }
  if (rule.type === 'exact') {
    if (normalizedUrl === rule.value) return true;
    const strippedUrl = normalizedUrl.replace(/\/+$/, '');
    const strippedValue = rule.value.replace(/\/+$/, '');
    return strippedUrl === strippedValue;
  }
  return false;
}

const allowed = svc.getAllowedLinks(0);
const testUrls = [
  'https://t.me/VoiceShazamBot?start=music_yt_LGDJau8b-wU',
  'https://t.me/VoiceShazamBot',
  'https://t.me/prepodsteam',
  'https://t.me/Shazambot?start=music_yt_mXKTtXNZ9Iw'
];

console.log('Allowed list entries count:', allowed.length);
for (const item of allowed) {
  const rule = parseAllowedLinkRule(item);
  console.log('ITEM:', item, '=> RULE:', rule);
}

for (const url of testUrls) {
  const normalizedUrl = normalizeAllowedUrl(url);
  console.log('\nTEST URL:', url, '=>', normalizedUrl);
  let matched = false;
  for (const item of allowed) {
    const rule = parseAllowedLinkRule(item);
    if (matchesAllowedRule(rule, normalizedUrl)) {
      console.log('  MATCHED by item:', item, 'rule=', rule);
      matched = true;
      break;
    }
  }
  if (!matched) console.log('  NO MATCH');
}
