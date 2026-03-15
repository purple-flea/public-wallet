module.exports = {
  apps: [
    {
      name: "public-wallet",
      script: "dist/server.js",
      cwd: "/home/dev/wallet",
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        PORT: "3005",
      },
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
    },
  ],
};
