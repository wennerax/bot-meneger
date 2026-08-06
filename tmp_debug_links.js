const ModerationService = require('./app/services/moderation_service');
const service = new ModerationService();
const urls = [
  'https://t.me/mir_supercell',
  'https://www.youtube.com/@MrLololoshka',
  'https://t.me/testgroup',
  'https://zvuk.com/track/123'
];
for (const url of urls) {
  console.log(url, service.isAllowedLink(0, url));
}
