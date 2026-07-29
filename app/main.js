const { loadConfig } = require('./config');
const { startBot } = require('./bot');

function main() {
  const config = loadConfig();
  console.log(`Bot manager ready with token: ${config.botToken ? 'configured' : 'missing'}`);
  console.log(`Admin IDs: ${config.adminIds.join(', ') || 'none'}`);
  console.log(`Database: ${config.databasePath}`);
  startBot();
}

if (require.main === module) {
  main();
}

module.exports = { main };
