/**
 * PM2 config. This VM runs several apps — always target this process by name
 * (`pm2 restart gatepass`), never `pm2 restart all`.
 */
module.exports = {
  apps: [
    {
      name: 'gatepass',
      script: 'server/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      // Photo processing with sharp is the memory high-water mark; restart if it runs away.
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
