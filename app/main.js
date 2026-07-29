const { loadConfig } = require('./config');
const { startBot } = require('./bot');

function main() {
  const config = loadConfig();
  console.log(`Bot manager ready with token: ${config.botToken ? 'configured' : 'missing'}`);
  console.log(`Admin IDs: ${config.adminIds.join(', ') || 'none'}`);
  console.log(`Database: ${config.databasePath}`);

  // Safe AI key presence log (do not print key value)
  console.log(`AI key present: ${config.aiApiKey ? 'yes' : 'no'}`);

  // Perform a lightweight AI endpoint check if a key is configured.
  // This will not log the key; it only reports status codes and friendly hints.
  const aiModule = require('./ai');
  (async function checkAi() {
    if (!config.aiApiKey) {
      startBot();
      return;
    }

    try {
      const result = await aiModule.checkAiEndpoint({ apiKey: config.aiApiKey, apiBaseUrl: config.aiApiBaseUrl, model: config.aiModel });
      if (result.status === 'ok') {
        console.log('AI endpoint check: reachable');
      } else if (result.status === 'unauthorized') {
        console.warn('AI endpoint check: unauthorized (401). Проверьте DEEPSEEK_API_KEY / AI_API_KEY и AI_API_BASE_URL. Не публикуйте ключи.');
      } else {
        console.warn('AI endpoint check:', result);
      }
    } catch (err) {
      console.warn('AI endpoint check failed:', err?.message || err);
    } finally {
      startBot();
    }
  })();
}

if (require.main === module) {
  main();
}

module.exports = { main };
