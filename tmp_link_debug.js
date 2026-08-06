const { isLinkMessage, isAllowedLinkUrl } = require('./app/bot');
console.log('example disallowed', isLinkMessage('https://example.com/shop', link => false));
console.log('allowed t.me', isLinkMessage('https://t.me/testgroup', link => true));
console.log('allowed url', isAllowedLinkUrl('https://t.me/testgroup'));
console.log('allowed query url', isAllowedLinkUrl('https://t.me/DigitalMusikBot?start=from_inline_caption'));
console.log('disallowed t.me extra', isLinkMessage('https://t.me/wwhisbot?start=faq/extra', link => false));
console.log('t.me allowed by prefix? ', isAllowedLinkUrl('https://t.me/buddy_music_bot?start=inv5008792526'));
