const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig } = require('../app/config');

function buildSettingsPayload(moderationService, chatId) {
  return {
    settings: {
      rulesEnabled: moderationService.isRulesEnabled(chatId),
      rulesText: moderationService.getRules(chatId),
      spamEnabled: moderationService.isSpamProtectionEnabled(chatId),
      floodEnabled: moderationService.isFloodProtectionEnabled(chatId),
      linkEnabled: moderationService.isLinkProtectionEnabled(chatId),
      captchaEnabled: moderationService.isCaptchaEnabled(chatId),
      captchaMode: moderationService.getCaptchaMode(chatId),
      captchaTimeout: moderationService.getCaptchaTimeoutMinutes(chatId),
      menuEnabled: moderationService.getMenuEnabled(chatId),
      menuText: moderationService.getMenuText(chatId),
      greetingText: moderationService.getGreeting(chatId),
      allowedLinks: moderationService.getAllowedLinks(chatId),
      banWords: moderationService.getBanWords(chatId),
      menuButtons: moderationService.getMenuButtons(chatId),
    },
  };
}

function buildMiniAppServer({ bot, moderationService, database }) {
  const app = express();
  const config = loadConfig();
  const publicDir = path.join(__dirname);

  app.use(express.json());
  app.use(express.static(publicDir));

  function verifyInitData(initData, chatId) {
    if (!initData || !config.botToken) {
      return false;
    }

    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) {
      return false;
    }

    const dataCheckString = Array.from(params.entries())
      .filter(([key]) => key !== 'hash')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(config.botToken).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (expectedHash !== hash) {
      return false;
    }

    const user = params.get('user');
    if (!user) {
      return false;
    }

    const parsedUser = JSON.parse(user);
    const authDate = Number(params.get('auth_date') || 0);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(authDate) || now - authDate > 86400) {
      return false;
    }

    const chat = params.get('chat');
    if (chat && Number(JSON.parse(chat).id) !== Number(chatId)) {
      return false;
    }

    return Boolean(parsedUser?.id);
  }

  function ensureAdminAccess(req, res, next) {
    const chatId = Number(req.query.chatId || req.body?.chatId || 0);
    const initData = req.get('x-telegram-init-data') || '';
    if (!verifyInitData(initData, chatId)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const user = JSON.parse(new URLSearchParams(initData).get('user') || '{}');
    const canManage = database.isBotAdmin(chatId, user?.id) || database.isPrimaryBotAdmin(chatId, user?.id);
    if (!canManage) {
      res.status(403).json({ error: 'Only administrators can use this app' });
      return;
    }

    next();
  }

  app.get('/api/miniapp/settings', ensureAdminAccess, (req, res) => {
    const chatId = Number(req.query.chatId || 0);
    if (!chatId) {
      res.status(400).json({ error: 'chatId is required' });
      return;
    }

    res.json(buildSettingsPayload(moderationService, chatId));
  });

  app.post('/api/miniapp/rules', ensureAdminAccess, (req, res) => {
    const chatId = Number(req.body?.chatId || 0);
    if (!chatId) {
      res.status(400).json({ error: 'chatId is required' });
      return;
    }

    moderationService.setRules(chatId, String(req.body?.text || ''));
    if (req.body?.enabled === true) {
      moderationService.enableRules(chatId);
    } else if (req.body?.enabled === false) {
      moderationService.disableRules(chatId);
    }

    res.json({ ok: true });
  });

  app.post('/api/miniapp/anti', ensureAdminAccess, (req, res) => {
    const chatId = Number(req.body?.chatId || 0);
    if (!chatId) {
      res.status(400).json({ error: 'chatId is required' });
      return;
    }

    if (req.body?.spamEnabled === true) {
      moderationService.enableSpamProtection(chatId);
    } else if (req.body?.spamEnabled === false) {
      moderationService.disableSpamProtection(chatId);
    }

    if (req.body?.floodEnabled === true) {
      moderationService.enableFloodProtection(chatId);
    } else if (req.body?.floodEnabled === false) {
      moderationService.disableFloodProtection(chatId);
    }

    if (req.body?.linkEnabled === true) {
      moderationService.enableLinkProtection(chatId);
    } else if (req.body?.linkEnabled === false) {
      moderationService.disableLinkProtection(chatId);
    }

    res.json({ ok: true });
  });

  app.post('/api/miniapp/captcha', ensureAdminAccess, (req, res) => {
    const chatId = Number(req.body?.chatId || 0);
    if (!chatId) {
      res.status(400).json({ error: 'chatId is required' });
      return;
    }

    if (req.body?.enabled === true) {
      moderationService.enableCaptcha(chatId);
    } else if (req.body?.enabled === false) {
      moderationService.disableCaptcha(chatId);
    }

    if (req.body?.mode) {
      moderationService.setCaptchaMode(chatId, req.body.mode);
    }

    if (req.body?.timeout !== undefined) {
      moderationService.setCaptchaTimeoutMinutes(chatId, req.body.timeout);
    }

    res.json({ ok: true });
  });

  app.post('/api/miniapp/menu', ensureAdminAccess, (req, res) => {
    const chatId = Number(req.body?.chatId || 0);
    if (!chatId) {
      res.status(400).json({ error: 'chatId is required' });
      return;
    }

    moderationService.setMenuText(chatId, String(req.body?.text || ''));
    if (req.body?.enabled === true) {
      moderationService.enableMenu(chatId);
    } else if (req.body?.enabled === false) {
      moderationService.disableMenu(chatId);
    }

    res.json({ ok: true });
  });

  app.post('/api/miniapp/buttons', ensureAdminAccess, (req, res) => {
    const chatId = Number(req.body?.chatId || 0);
    if (!chatId) {
      res.status(400).json({ error: 'chatId is required' });
      return;
    }

    const text = String(req.body?.text || '').trim();
    const url = String(req.body?.url || '').trim();
    if (!text || !url) {
      res.status(400).json({ error: 'text and url are required' });
      return;
    }

    const rowIndex = Number.isFinite(Number(req.body?.rowIndex)) ? Number(req.body.rowIndex) : null;
    moderationService.addMenuButton(chatId, text, url, rowIndex);
    res.json({ ok: true });
  });

  app.post('/api/miniapp/allowed-links', ensureAdminAccess, (req, res) => {
    const chatId = Number(req.body?.chatId || 0);
    if (!chatId) {
      res.status(400).json({ error: 'chatId is required' });
      return;
    }

    moderationService.clearAllowedLinks(chatId);
    const values = Array.isArray(req.body?.values) ? req.body.values : String(req.body?.values || '').split(/\n+/);
    values.filter((item) => String(item || '').trim()).forEach((item) => moderationService.addAllowedLink(chatId, String(item).trim()));
    res.json({ ok: true });
  });

  app.post('/api/miniapp/banwords', ensureAdminAccess, (req, res) => {
    const chatId = Number(req.body?.chatId || 0);
    if (!chatId) {
      res.status(400).json({ error: 'chatId is required' });
      return;
    }

    const values = Array.isArray(req.body?.values) ? req.body.values : String(req.body?.values || '').split(/\n+/);
    const existing = moderationService.getBanWords(chatId);
    existing.forEach((item) => moderationService.removeBanWord(chatId, item));
    values.filter((item) => String(item || '').trim()).forEach((item) => moderationService.addBanWord(chatId, String(item).trim()));
    res.json({ ok: true });
  });

  app.post('/api/miniapp/greeting', ensureAdminAccess, (req, res) => {
    const chatId = Number(req.body?.chatId || 0);
    if (!chatId) {
      res.status(400).json({ error: 'chatId is required' });
      return;
    }

    moderationService.setGreeting(chatId, String(req.body?.text || ''));
    res.json({ ok: true });
  });

  return app;
}

module.exports = { buildMiniAppServer, buildSettingsPayload };
