module.exports = {
  apps: [{
    name: 'chainvault-site',
    script: 'site/server.js',
    cwd: '/home/tippyflits/chainvault-demo',
    env: {
      NODE_ENV: 'production',
      PORT: '3860',
      CV_DATA: '/home/tippyflits/chainvault',
      CV_REHYDRATE: '/home/tippyflits/chainvault-demo/archiver/rehydrate.py',
      CV_REHYDRATE_TOKEN: 'CHANGE_ME',
      PATH: '/home/tippyflits/.nvm/versions/node/v22.21.0/bin:/usr/local/bin:/usr/bin:/bin',
    },
    max_memory_restart: '300M',
  }],
};
