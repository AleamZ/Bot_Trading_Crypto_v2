// module.exports = {
//   apps: [
//     {
//       name: "smc-futures-api",
//       script: "apps/api/dist/src/main.js",
//       instances: 1,
//       exec_mode: "fork",
//       autorestart: true,
//       max_restarts: 10,
//       min_uptime: "10s",
//       restart_delay: 5000,
//       kill_timeout: 15000,
//       time: true,
//       out_file: "/var/log/smc-futures-api/out.log",
//       error_file: "/var/log/smc-futures-api/error.log",
//       env: {
//         NODE_ENV: "production"
//       }
//     }
//   ]
// };

const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "smc-futures-api",

      cwd: "./apps/api",
      script: "dist/src/main.js",

      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 5000,
      kill_timeout: 15000,
      time: true,

      out_file: path.resolve(__dirname, "logs/smc-futures-api/out.log"),
      error_file: path.resolve(__dirname, "logs/smc-futures-api/error.log"),

      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
