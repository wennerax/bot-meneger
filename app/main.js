const { loadConfig } = require('./config');
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

  // Perform a lightweight AI endpoint check if a key is configured.
  // This will not log the key; it only reports status codes and friendly hints.
  const aiModule = require('./ai');
  let miniAppServer = null;
  (async function checkAi() {
    const botState = createBot();
    if (!config.aiApiKey) {
      startBot(botState);
      return;
    }

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
    } finally {
      startBot(botState);
      try {
        miniAppServer = buildMiniAppServer({
          bot: botState.bot,
          moderationService: botState.moderationService,
          database: botState.database,
        });
        const port = Number(process.env.MINIAPP_PORT || 3000);
        const miniAppUrl = config.miniAppUrl || `http://localhost:${port}`;
        miniAppServer.listen(port, () => {
          console.log(`Mini app server listening on ${miniAppUrl}`);
          console.log(`Mini app permanent URL: ${miniAppUrl}`);
        });
      } catch (error) {
        console.warn('Mini app server startup failed:', error?.message || error);
      }
    }
  })();
}

if (require.main === module) {
  main();
}

module.exports = { main };
