const { loadConfig, getMiniAppPort, detectPublicMiniAppUrl } = require('./config');
const { createBot, startBot } = require('./bot');
const { buildMiniAppServer } = require('../miniapp/server');

function main() {
  const config = loadConfig();
  console.log(`Bot manager ready with token: ${config.botToken ? 'configured' : 'missing'}`);
  console.log(`Admin IDs: ${config.adminIds.join(', ') || 'none'}`);
  console.log(`Database: ${config.databasePath}`);

  if (process.env.NODE_ENV === 'production' && !process.env.BOT_TOKEN) {
    console.error('Production mode requires BOT_TOKEN to be supplied via environment variables. .env is ignored.');
  }

  // Safe AI key presence log (do not print key value)
  console.log(`AI key present: ${config.aiApiKey ? 'yes' : 'no'}`);

  const botState = createBot();
  const miniAppServer = buildMiniAppServer({
    bot: botState.bot,
    moderationService: botState.moderationService,
    database: botState.database,
  });
  const port = getMiniAppPort();
  const miniAppUrl = detectPublicMiniAppUrl(config, port);

  miniAppServer.listen(port, () => {
    console.log(`Mini app server listening on http://localhost:${port}`);
    console.log(`Mini app permanent URL: ${miniAppUrl}`);
    saveMiniAppUrlToFile(miniAppUrl);
  });

  startBot(botState);

  if (config.aiApiKey) {
    const aiModule = require('./ai');
    (async function checkAi() {
      try {
        const result = await aiModule.checkAiEndpoint({ apiKey: config.aiApiKey, apiBaseUrl: config.aiApiBaseUrl, model: config.aiModel });
        if (result.status === 'ok') {
          console.log('AI endpoint check: reachable');
        } else if (result.status === 'unauthorized') {
          console.warn('AI endpoint check: unauthorized (401). Проверьте OPENROUTER_API_KEY / AI_API_KEY и AI_API_BASE_URL. Не публикуйте ключи.');
        } else {
          console.warn('AI endpoint check:', result);
        }
      } catch (err) {
        console.warn('AI endpoint check failed:', err?.message || err);
      }
    })();
  } else {
    console.log('AI endpoint check skipped: no key configured');
  }
}

const fs = require('node:fs');
const path = require('node:path');

function saveMiniAppUrlToFile(url) {
  try {
    const filePath = path.join(__dirname, '..', 'data', 'miniapp_url.txt');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, String(url || '').trim(), 'utf8');
    console.log(`Mini app URL saved to ${filePath}`);
  } catch (error) {
    console.warn('Failed to save mini app URL to file:', error?.message || error);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
