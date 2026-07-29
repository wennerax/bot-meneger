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
  (async function checkAi() {
    if (!config.aiApiKey) {
      startBot();
      return;
    }

    try {
      const testBody = JSON.stringify({ model: config.aiModel, messages: [{ role: 'user', content: 'ping' }] });
      const res = await fetch(`${config.aiApiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.aiApiKey}`,
        },
        body: testBody,
      });

      if (res.ok) {
        console.log('AI endpoint check: reachable');
      } else if (res.status === 401) {
        console.warn('AI endpoint check: unauthorized (401). Проверьте DEEPSEEK_API_KEY / AI_API_KEY и AI_API_BASE_URL. Не публикуйте ключи.');
      } else {
        console.warn(`AI endpoint check: ${res.status} ${res.statusText}`);
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
