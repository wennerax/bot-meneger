const { loadConfig } = require('./config');
const { createBot, startBot } = require('./bot');

function main() {
  const reloadDelayMs = Number(process.env.BOT_RELOAD_DELAY_MS || 0);
  const reloadChatId = process.env.BOT_RELOAD_CHAT_ID;
  const reloadMessageId = process.env.BOT_RELOAD_MESSAGE_ID;
  if (Number.isFinite(reloadDelayMs) && reloadDelayMs > 0) {
    delete process.env.BOT_RELOAD_DELAY_MS;
    setTimeout(main, reloadDelayMs);
    return;
  }

  delete process.env.BOT_RELOAD_CHAT_ID;
  delete process.env.BOT_RELOAD_MESSAGE_ID;

  const config = loadConfig();
  console.log(`Bot manager ready with token: ${config.botToken ? 'configured' : 'missing'}`);
  console.log(`Admin IDs: ${config.adminIds.join(', ') || 'none'}`);
  console.log(`Reload admin IDs: ${config.reloadAdminIds.join(', ') || 'none'}`);
  console.log(`Database: ${config.databasePath}`);

  if (process.env.NODE_ENV === 'production' && !process.env.BOT_TOKEN) {
    console.error('Production mode requires BOT_TOKEN to be supplied via environment variables. .env is ignored.');
  }

  // Safe AI key presence log (do not print key value)
  console.log(`AI key present: ${config.aiApiKey ? 'yes' : 'no'}`);

  const botState = createBot();
  startBot(botState);

  if (reloadChatId && reloadMessageId) {
    setTimeout(async () => {
      try {
        await botState.bot.telegram.editMessageText(
          reloadChatId,
          Number(reloadMessageId),
          undefined,
          '✅ Бот успешно перезапустился.',
        );
      } catch (error) {
        console.warn('Failed to update reload status message:', error?.message || error);
      }
    }, 2500);
  }

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

if (require.main === module) {
  main();
}

module.exports = { main };
