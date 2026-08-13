const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../app/config');

test('admin ids are parsed from comma separated values', () => {
  const settings = loadConfig({ BOT_TOKEN: 'token', ADMIN_IDS: '10, 20,10' }, { filePath: '.env' });

  assert.deepEqual(settings.adminIds, [10, 20]);
});

test('empty admin ids become an empty array', () => {
  const settings = loadConfig({ BOT_TOKEN: 'token', ADMIN_IDS: '' }, { filePath: '.env' });

  assert.deepEqual(settings.adminIds, []);
});

test('production ignores default .env file for BOT_TOKEN', () => {
  const rootDir = path.resolve(__dirname, '..');
  const envPath = path.join(rootDir, '.env');
  const hadEnvFile = fs.existsSync(envPath);
  const originalEnv = hadEnvFile ? fs.readFileSync(envPath, 'utf8') : null;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalToken = process.env.BOT_TOKEN;

  try {
    fs.writeFileSync(envPath, 'BOT_TOKEN=token_from_dotenv\n');
    process.env.NODE_ENV = 'production';
    process.env.BOT_TOKEN = '';

    const settings = loadConfig({}, {});
    assert.equal(settings.botToken, '');
  } finally {
    if (hadEnvFile) {
      fs.writeFileSync(envPath, originalEnv);
    } else {
      fs.unlinkSync(envPath);
    }
    process.env.NODE_ENV = originalNodeEnv;
    process.env.BOT_TOKEN = originalToken;
  }
});

test('OpenAI env variables are recognized by config loader', () => {
  const settings = loadConfig({
    OPENAI_API_KEY: 'sk-openai-test',
    OPENAI_MODEL: 'gpt-4o-mini',
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
  }, { filePath: '.env' });

  assert.equal(settings.aiApiKey, 'sk-openai-test');
  assert.equal(settings.aiModel, 'gpt-4o-mini');
  assert.equal(settings.aiApiBaseUrl, 'https://api.openai.com/v1');
});
