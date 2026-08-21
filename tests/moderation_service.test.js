const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ModerationService = require('../app/services/moderation_service');

test('warnings are stored per chat and user', () => {
  const service = new ModerationService();

  assert.equal(service.addWarning(100, 7), 1);
  assert.equal(service.addWarning(100, 7), 2);
  assert.equal(service.getWarnings(100, 7), 2);
  assert.equal(service.getWarnings(200, 7), 0);
});

test('moderation logs store recent actions and can be cleared', () => {
  const service = new ModerationService();

  service.addModerationLog(100, {
    action: 'warn',
    actorId: 10,
    targetId: 7,
    reason: 'Спам',
    details: 'Предупреждение за спам',
  });
  service.addModerationLog(100, {
    action: 'mute',
    actorId: 10,
    targetId: 7,
    reason: 'Реклама',
    duration: '10m',
    details: 'Мут на 10 минут',
  });

  const logs = service.getModerationLogs(100, 10);
  assert.equal(logs.length, 2);
  assert.equal(logs[0].action, 'mute');
  assert.equal(logs[1].reason, 'Спам');

  service.clearModerationLogs(100);
  assert.deepEqual(service.getModerationLogs(100, 10), []);
});

test('rules and filters are stored per chat and can be removed', () => {
  const service = new ModerationService();

  service.setRules(100, 'Будьте вежливы');
  service.addFilter(100, 'привет', 'Привет!');

  assert.equal(service.getRules(100), 'Будьте вежливы');
  assert.equal(service.findFilterResponse(100, 'ПРИВЕТ всем'), 'Привет!');
  assert.equal(service.findFilterResponse(200, 'привет'), null);
  assert.equal(service.removeFilter(100, 'SPAM'), false);
});

test('admin rules are stored separately and can be toggled', () => {
  const service = new ModerationService();

  service.setRules(100, 'Правила для всех');
  service.setAdminRules(100, 'Правила для администраторов');

  assert.equal(service.getRules(100), 'Правила для всех');
  assert.equal(service.getAdminRules(100), 'Правила для администраторов');
  assert.equal(service.isAdminRulesEnabled(100), true);

  service.disableAdminRules(100);
  assert.equal(service.isAdminRulesEnabled(100), false);

  service.enableAdminRules(100);
  assert.equal(service.isAdminRulesEnabled(100), true);
});

test('admin notification group is stored per chat', () => {
  const service = new ModerationService();

  assert.equal(service.getAdminNotifyGroupId(100), 0);
  assert.equal(service.setAdminNotifyGroupId(100, -1001234567890), true);
  assert.equal(service.getAdminNotifyGroupId(100), -1001234567890);
  assert.equal(service.getAdminNotifyGroupId(200), 0);
  assert.equal(service.setAdminNotifyGroupId(100, 0), false);

  service.clearAdminNotifyGroupId(100);
  assert.equal(service.getAdminNotifyGroupId(100), 0);
});

test('admin notification group resolves linked source chats', () => {
  const service = new ModerationService();

  service.setAdminNotifyGroupId(100, -1001234567890);
  service.setAdminNotifyGroupId(200, -1001234567890);
  service.setAdminNotifyGroupId(300, -1009876543210);

  assert.deepEqual(service.getAdminNotifySourceChats(-1001234567890).sort((a, b) => a - b), [100, 200]);
  assert.deepEqual(service.getAdminNotifySourceChats(-1009876543210), [300]);
});

test('spam and link protection can be toggled per chat', () => {
  const service = new ModerationService();

  assert.equal(service.isSpamProtectionEnabled(100), false);
  assert.equal(service.isLinkProtectionEnabled(100), false);

  service.enableSpamProtection(100);
  service.enableLinkProtection(100);

  assert.equal(service.isSpamProtectionEnabled(100), true);
  assert.equal(service.isLinkProtectionEnabled(100), true);

  service.disableSpamProtection(100);
  service.disableLinkProtection(100);

  assert.equal(service.isSpamProtectionEnabled(100), false);
  assert.equal(service.isLinkProtectionEnabled(100), false);
});

test('flood protection can be toggled per chat', () => {
  const service = new ModerationService();

  assert.equal(service.isFloodProtectionEnabled(100), false);

  service.enableFloodProtection(100);
  assert.equal(service.isFloodProtectionEnabled(100), true);

  service.disableFloodProtection(100);
  assert.equal(service.isFloodProtectionEnabled(100), false);
});

test('rules feature can be enabled and disabled per chat', () => {
  const service = new ModerationService();

  assert.equal(service.isRulesEnabled(100), true);

  service.disableRules(100);
  assert.equal(service.isRulesEnabled(100), false);

  service.enableRules(100);
  assert.equal(service.isRulesEnabled(100), true);
});

test('streak feature can be enabled and disabled per chat', () => {
  const service = new ModerationService();

  assert.equal(service.isStreaksEnabled(100), true);

  service.disableStreaks(100);
  assert.equal(service.isStreaksEnabled(100), false);

  service.enableStreaks(100);
  assert.equal(service.isStreaksEnabled(100), true);
});

test('chat access mode restricts writes to allowed roles', () => {
  const service = new ModerationService();

  assert.equal(service.canWriteInChat(100, 7, false, false), true);
  service.setChatAccessMode(100, 'closed');
  assert.equal(service.canWriteInChat(100, 7, false, false), false);
  assert.equal(service.canWriteInChat(100, 7, false, true), false);
  service.setChatAccessMode(100, 'admins');
  assert.equal(service.canWriteInChat(100, 7, false, false), false);
  assert.equal(service.canWriteInChat(100, 7, false, true), true);
  service.setChatAccessMode(100, 'owner');
  assert.equal(service.canWriteInChat(100, 7, true, false), true);
  assert.equal(service.canWriteInChat(100, 7, false, false), false);
  service.setChatAccessMode(100, 'open');
  assert.equal(service.canWriteInChat(100, 7, false, false), true);
});

test('chat starts with no allowed links by default', () => {
  const service = new ModerationService();

  assert.deepEqual(service.getAllowedLinks(100), []);
  assert.equal(service.isAllowedLink(100, 'https://t.me/wwhisbot?start=faq'), false);
});

test('allowed links accept only exact configured URLs', () => {
  const service = new ModerationService();

  assert.equal(service.isAllowedLink(100, 'https://t.me/wwhisbot?start=faq'), false);
  assert.equal(service.isAllowedLink(100, 'https://t.me/wwhisbot?start=faq/extra'), false);
  assert.equal(service.isAllowedLink(100, 'https://example.com/shop'), false);

  service.addAllowedLink(100, 'https://t.me/mir_supercell');
  assert.equal(service.isAllowedLink(100, 'https://t.me/mir_supercell'), true);
  assert.equal(service.isAllowedLink(100, 'https://t.me/mir_supercell/other'), false);
});

test('allowed links with query parameters are matched exactly', () => {
  const service = new ModerationService();
  service.addAllowedLink(100, 'https://t.me/DigitalMusikBot?start=from_inline_caption');

  assert.equal(service.isAllowedLink(100, 'https://t.me/DigitalMusikBot?start=from_inline_caption'), true);
  assert.equal(service.isAllowedLink(100, 'https://t.me/DigitalMusikBot?start=from_inline_caption&foo=bar'), false);
});

test('allowed domain prefixes permit links under the same host', () => {
  const service = new ModerationService();
  service.addAllowedLink(100, 'https://zvuk.com/');

  assert.equal(service.isAllowedLink(100, 'https://zvuk.com/track/123'), true);
  assert.equal(service.isAllowedLink(100, 'https://zvuk.com'), true);
  assert.equal(service.isAllowedLink(100, 'https://zvuk.com/track?foo=bar'), true);
  assert.equal(service.isAllowedLink(100, 'https://example.com/track/123'), false);
});

test('allowed domain rules without trailing slash still permit host and subpaths', () => {
  const service = new ModerationService();
  service.addAllowedLink(100, 'https://customdomain.test');

  assert.equal(service.isAllowedLink(100, 'https://customdomain.test'), true);
  assert.equal(service.isAllowedLink(100, 'https://customdomain.test/watch?v=123'), true);
  assert.equal(service.isAllowedLink(100, 'https://otherdomain.test/watch?v=123'), false);
});

test('allowed domain rules permit query strings directly after the host', () => {
  const service = new ModerationService();
  service.addAllowedLink(100, 'https://example.com');

  assert.equal(service.isAllowedLink(100, 'https://example.com?utm=1'), true);
  assert.equal(service.isAllowedLink(100, 'https://example.com#section'), true);
  assert.equal(service.isAllowedLink(100, 'https://example.net?utm=1'), false);
});

test('allowed link can be removed from chat allowlist', () => {
  const service = new ModerationService();
  service.addAllowedLink(100, 'https://example.com');
  service.addAllowedLink(100, 'https://t.me/bot');

  assert.equal(service.removeAllowedLink(100, 'https://example.com'), true);
  assert.equal(service.isAllowedLink(100, 'https://example.com'), false);
  assert.equal(service.isAllowedLink(100, 'https://t.me/bot'), true);
  assert.equal(service.removeAllowedLink(100, 'https://example.com'), false);
});

test('clearAllowedLinks removes all allowed links from chat', () => {
  const service = new ModerationService();
  service.addAllowedLink(100, 'https://example.com');
  service.addAllowedLink(100, 'vk_musix_bot');

  assert.equal(service.clearAllowedLinks(100), true);
  assert.deepEqual(service.getAllowedLinks(100), []);
  assert.equal(service.clearAllowedLinks(100), false);
});

test('allowed forwards match Telegram source ids, usernames and links', () => {
  const service = new ModerationService();

  service.addAllowedForward(100, 'https://t.me/bredish');
  service.addAllowedForward(100, '-100123456789');

  assert.equal(service.isAllowedForward(100, {
    forward_from_chat: { id: -100987654321, type: 'channel', username: 'other_channel' },
  }), false);
  assert.equal(service.isAllowedForward(100, {
    forward_from_chat: { id: -100123456789, type: 'channel', username: 'other_channel' },
  }), true);
  assert.equal(service.isAllowedForward(100, {
    forward_from_chat: { id: -100987654321, type: 'channel', username: 'bredish' },
  }), true);
});

test('username-like allowed links are exempted for all matching variations', () => {
  const service = new ModerationService();
  service.addAllowedLink(100, 'vk_musix_bot');

  assert.equal(service.isAllowedLink(100, 'https://t.me/vk_musix_bot'), true);
  assert.equal(service.isAllowedLink(100, 'vk_musix_bot'), true);
  assert.equal(service.isAllowedLink(100, 'https://t.me/vk_musix_bot?start=abc'), true);
  assert.equal(service.isAllowedLink(100, 'https://t.me/other_bot?start=vk_musix_bot'), true);
});

test('captcha settings can be enabled, disabled and switched by mode', () => {
  const service = new ModerationService();

  assert.equal(service.isCaptchaEnabled(100), true);
  service.disableCaptcha(100);
  assert.equal(service.isCaptchaEnabled(100), false);
  service.enableCaptcha(100);
  assert.equal(service.isCaptchaEnabled(100), true);

  assert.equal(service.getCaptchaMode(100), 'emoji');
  service.setCaptchaMode(100, 'math');
  assert.equal(service.getCaptchaMode(100), 'math');

  assert.equal(service.getCaptchaTimeoutMinutes(100), 3);
  service.setCaptchaTimeoutMinutes(100, 10);
  assert.equal(service.getCaptchaTimeoutMinutes(100), 10);
});

test('agreement settings can be enabled and configured', () => {
  const service = new ModerationService();

  assert.equal(service.isAgreementEnabled(100), false);

  service.enableAgreement(100);
  assert.equal(service.isAgreementEnabled(100), true);

  service.setAgreementText(100, 'Прочитайте правила и подтвердите согласие.');
  assert.equal(service.getAgreementText(100), 'Прочитайте правила и подтвердите согласие.');

  service.setAgreementMedia(100, { type: 'photo', fileId: 'abc123' });
  assert.deepEqual(service.getAgreementMedia(100), { type: 'photo', fileId: 'abc123' });

  service.clearAgreementMedia(100);
  assert.equal(service.getAgreementMedia(100), null);
});

test('ban words are detected with suffixes and shortened variations', () => {
  const service = new ModerationService();

  // Prefix match - word with extra characters at the end (obfuscation)
  assert.equal(service.findBanWord(100, 'наркомыы'), 'нарко');
  assert.equal(service.findBanWord(100, 'мефедрончик'), 'мефедрон');
  // Exact match
  assert.equal(service.findBanWord(100, 'я хочу вздернусь прямо сейчас'), 'вздернусь');
  assert.equal(service.findBanWord(100, 'самоубийство это тот путь'), 'самоубийство');
  // Prefix match
  assert.equal(service.findBanWord(100, 'тут метадончик ответ'), 'метадон');
});

test('moderation settings persist across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-meneger-'));
  const filePath = path.join(dir, 'bot.json');

  const first = new ModerationService(filePath);
  first.setRules(100, 'Будьте вежливы');
  first.setGreeting(100, 'Добро пожаловать');
  first.enableSpamProtection(100);
  first.disableRules(100);
  first.addWarning(100, 7);
  first.addFilter(100, 'привет', 'Привет!');

  const second = new ModerationService(filePath);

  assert.equal(second.getRules(100), 'Будьте вежливы');
  assert.equal(second.getGreeting(100), 'Добро пожаловать');
  assert.equal(second.isSpamProtectionEnabled(100), true);
  assert.equal(second.isRulesEnabled(100), false);
  assert.equal(second.getWarnings(100, 7), 1);
  assert.equal(second.findFilterResponse(100, 'ПРИВЕТ всем'), 'Привет!');
});

test('allowed anonymous channels can be added and removed per chat', () => {
  const service = new ModerationService();

  assert.equal(service.isAllowedAnonymousChannel(100, 777), false);
  assert.equal(service.addAllowedAnonymousChannel(100, 777), true);
  assert.deepEqual(service.getAllowedAnonymousChannels(100), ['777']);
  assert.equal(service.isAllowedAnonymousChannel(100, 777), true);
  assert.equal(service.addAllowedAnonymousChannel(100, 777), false);
  assert.equal(service.removeAllowedAnonymousChannel(100, 777), true);
  assert.deepEqual(service.getAllowedAnonymousChannels(100), []);
  assert.equal(service.isAllowedAnonymousChannel(100, 777), false);
});

test('first bot comment can be enabled and disabled independently from the message text', () => {
  const service = new ModerationService();

  assert.equal(service.getMenuEnabled(100), true);
  assert.equal(service.disableMenu(100), true);
  assert.equal(service.getMenuEnabled(100), false);
  assert.equal(service.enableMenu(100), true);
  assert.equal(service.getMenuEnabled(100), true);
});

test('menu buttons support row layout and persistence', () => {
  const service = new ModerationService();

  assert.equal(service.getMenuButtons(100).length, 0);
  assert.equal(service.addMenuRow(100), true);
  assert.deepEqual(service.getMenuButtons(100), [[]]);

  assert.equal(service.addMenuButton(100, 'Google', 'https://google.com', 0), true);
  assert.deepEqual(service.getMenuButtons(100), [[{ text: 'Google', url: 'https://google.com' }]]);

  assert.equal(service.addMenuRow(100), true);
  assert.equal(service.addMenuButton(100, 'Yandex', 'https://yandex.ru', 1), true);
  assert.deepEqual(service.getMenuButtons(100), [
    [{ text: 'Google', url: 'https://google.com' }],
    [{ text: 'Yandex', url: 'https://yandex.ru' }],
  ]);

  assert.equal(service.removeMenuButton(100, 0, 0), true);
  assert.deepEqual(service.getMenuButtons(100), [[], [{ text: 'Yandex', url: 'https://yandex.ru' }]]);

  assert.equal(service.removeMenuRow(100, 0), true);
  assert.deepEqual(service.getMenuButtons(100), [[{ text: 'Yandex', url: 'https://yandex.ru' }]]);

  assert.equal(service.clearMenuButtons(100), true);
  assert.deepEqual(service.getMenuButtons(100), []);
});

test('banned words are detected when they are prefixed with extra characters', () => {
  const service = new ModerationService();
  service.addBanWord(100, 'нарко');
  service.addBanWord(100, 'меф');

  assert.equal(service.findBanWord(100, 'наркоывф'), 'нарко');
  assert.equal(service.findBanWord(100, 'мефылзщ'), 'меф');
});

test('message text can render clickable link labels', () => {
  const service = new ModerationService();

  const first = service.formatTextWithLinks('Привет(https://example.com)');
  assert.equal(first.text, 'Привет');
  assert.deepEqual(first.entities, [{ offset: 0, length: 6, type: 'text_link', url: 'https://example.com' }]);

  const second = service.formatTextWithLinks('ИЯЙ(https://t.me/bred_ish)');
  assert.equal(second.text, 'ИЯЙ');
  assert.deepEqual(second.entities, [{ offset: 0, length: 3, type: 'text_link', url: 'https://t.me/bred_ish' }]);

  const third = service.formatTextWithLinks('Обычный текст');
  assert.equal(third.text, 'Обычный текст');
  assert.deepEqual(third.entities, []);
});

test('premium emoji entities are preserved when formatting text', () => {
  const service = new ModerationService();
  const payload = service.formatTextWithLinks({
    text: '🙂 привет',
    entities: [{ type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: 'premium_1' }],
  });

  assert.equal(payload.text, '🙂 привет');
  assert.deepEqual(payload.entities, [{ type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: 'premium_1' }]);
});
