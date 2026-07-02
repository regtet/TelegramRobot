const path = require('path');
const paths = require('../paths');

require('dotenv').config({ path: paths.envFile });

module.exports = {
  buildProjectPath: process.env.BUILD_PROJECT_PATH || '../WG-WEB',

  allowedUsers: process.env.ALLOWED_USERS
    ? process.env.ALLOWED_USERS.split(',').map((id) => id.trim())
    : [],

  build: {
    buildCommand: process.env.BUILD_COMMAND || 'npm run build:secure',
    distPath: 'dist',
    zipOutputPath: paths.buildsDir,
    autoInstall: false,
    autoFetchPull: true,
    allowedBranches: [],
  },
};
