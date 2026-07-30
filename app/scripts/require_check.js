try {
  require('../config');
  require('../ai');
  require('../bot');
  require('../main');
  console.log('modules ok');
} catch (err) {
  console.error('module load error:', err && err.stack ? err.stack : err);
  process.exit(1);
}
