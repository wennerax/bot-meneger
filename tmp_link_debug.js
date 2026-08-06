const { isLinkMessage, isAllowedLinkUrl } = require('./app/bot');
console.log('link example', isLinkMessage('https://example.com/shop', () => false));
console.log('allowed url', isAllowedLinkUrl('https://t.me/testgroup'));
console.log('allowed query url', isAllowedLinkUrl('https://t.me/DigitalMusikBot?start=from_inline_caption'));
console.log('link allowed should be false', isLinkMessage('https://t.me/testgroup', (link) => true));
console.log('link disallowed should be true', isLinkMessage('https://example.com/shop', (link) => false));
