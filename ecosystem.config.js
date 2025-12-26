module.exports = {
  apps: [
    {
      name: "recorder",
      script: "index.js",        // или server/index.js - как у тебя
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        WEBRTC_LISTEN_IP: "0.0.0.0",
        WEBRTC_ANNOUNCED_IP: "34.179.130.224",
      },
    },
  ],
};
