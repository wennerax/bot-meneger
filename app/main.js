const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');
const { createBot, startBot } = require('./bot');

const instanceLockPath = path.join(__dirname, '..', 'data', 'bot-instance.lock');
const reloadLockPath = path.join(__dirname, '..', 'data', 'bot-reload.lock');
const reloadStatusPath = path.join(__dirname, '..', 'data', 'bot-reload-status.json');

function acquireInstanceLock(replacingPid = null) {
  fs.mkdirSync(path.dirname(instanceLockPath), { recursive: true });

  try {
    fs.writeFileSync(instanceLockPath, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }

    const existingPid = Number(fs.readFileSync(instanceLockPath, 'utf8'));
    if (Number.isFinite(replacingPid) && existingPid === replacingPid) {
      fs.unlinkSync(instanceLockPath);
      fs.writeFileSync(instanceLockPath, String(process.pid), { flag: 'wx' });
      return registerInstanceLockCleanup();
    }

    try {
      process.kill(existingPid, 0);
      console.error(`Another bot instance is already running (PID ${existingPid}).`);
      return false;
    } catch (probeError) {
      fs.unlinkSync(instanceLockPath);
      fs.writeFileSync(instanceLockPath, String(process.pid), { flag: 'wx' });
    }
  }

  return registerInstanceLockCleanup();
}

function registerInstanceLockCleanup() {
  const releaseLock = () => {
    try {
      if (Number(fs.readFileSync(instanceLockPath, 'utf8')) === process.pid) {
        fs.unlinkSync(instanceLockPath);
      }
    } catch (error) {
      // The lock may already be removed during shutdown.
    }
  };
  process.once('exit', releaseLock);
  process.once('SIGINT', () => {
    releaseLock();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    releaseLock();
    process.exit(0);
  });
  return true;
}

function releaseReloadLock() {
  try {
    fs.unlinkSync(reloadLockPath);
  } catch (error) {
    // The lock may already be removed after a failed reload.
  }
}

function claimReloadStatus() {
  const claimedPath = `${reloadStatusPath}.${process.pid}.processing`;
  try {
    fs.renameSync(reloadStatusPath, claimedPath);
    return {
      path: claimedPath,
      status: JSON.parse(fs.readFileSync(claimedPath, 'utf8')),
    };
  } catch (error) {
    return null;
  }
}

function clearReloadStatus(statusPath) {
  try {
    fs.unlinkSync(statusPath);
  } catch (error) {
    // The status may already be removed after a successful update.
  }
}

function main() {
  if (!acquireInstanceLock()) {
    return;
  }

  const reloadStatusClaim = claimReloadStatus();
  const reloadStatus = reloadStatusClaim?.status;

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
  releaseReloadLock();

  startBot(botState, async (bot) => {
    if (reloadStatus?.chatId && reloadStatus?.messageId) {
      try {
        const successText = typeof reloadStatus.successText === 'string' && reloadStatus.successText
          ? reloadStatus.successText
          : '✅ Бот успешно перезапустился.';
        try {
          await bot.telegram.editMessageText(
            reloadStatus.chatId,
            Number(reloadStatus.messageId),
            undefined,
            successText,
          );
        } catch (error) {
          console.warn('Failed to update reload status message:', error?.message || error);
        }
        try {
          await bot.telegram.deleteMessage(reloadStatus.chatId, Number(reloadStatus.messageId));
        } catch (error) {
          console.warn('Failed to delete reload status message:', error?.message || error);
        }
        clearReloadStatus(reloadStatusClaim.path);
      } catch (error) {
        console.warn('Failed to clean up reload status message:', error?.message || error);
        clearReloadStatus(reloadStatusClaim.path);
      }
    }
  });

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
