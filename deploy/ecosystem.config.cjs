const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, 'chainvault.env');
const fileEnv = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split('\n')
  .filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"(.*)"$/, '$1')]));
module.exports = {
  apps: [{
    name: 'chainvault-site',
    script: 'site/server.js',
    cwd: path.join(__dirname, '..'),
    env: {
      NODE_ENV: 'production',
      PORT: '3860',
      CV_DATA: fileEnv.CV_WORKDIR || '/home/tippyflits/chainvault',
      CV_REHYDRATE: path.join(__dirname, '..', 'archiver', 'rehydrate.py'),
      CV_REHYDRATE_TOKEN: fileEnv.CV_REHYDRATE_TOKEN || '',
      CV_REHYDRATE_PROVIDER: fileEnv.CV_REHYDRATE_PROVIDER || '',
      CV_FOREST_BIN: fileEnv.CV_FOREST_BIN || '',
      CV_FOREST_ARGS: fileEnv.CV_FOREST_ARGS || '',
      PATH: fileEnv.PATH || process.env.PATH,
    },
    max_memory_restart: '300M',
  }],
};
