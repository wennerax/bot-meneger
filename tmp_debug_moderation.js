const ModerationService = require('./app/services/moderation_service');
const service = new ModerationService();
service.addAllowedLink(100, 'https://customdomain.test');
const allowed = service.getAllowedLinks(100);
console.log('allowed', allowed);
const inputs = [
  'https://customdomain.test',
  'https://customdomain.test/watch?v=123',
  'https://otherdomain.test/watch?v=123'
];
for (const input of inputs) {
  const result = service.isAllowedLink(100, input);
  console.log(input, '=>', result);
}
