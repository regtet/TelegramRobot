const path = require('path');
const paths = require('../paths');

require('dotenv').config({ path: paths.envFile });

module.exports = {
  buildProjectPath: process.env.BUILD_PROJECT_PATH || '../WG-WEB',

  allowedUsers: process.env.ALLOWED_USERS
    ? process.env.ALLOWED_USERS.split(',').map((id) => id.trim())
    : [],

  build: {
    buildCommand: 'npm run build',
    distPath: 'dist',
    zipOutputPath: paths.buildsDir,
    autoInstall: false,
    autoFetchPull: true,
    allowedBranches: [],
    strictMessageFilter: true,
    enableFileSplit: false,
    splitSizeThreshold: 20,
    chunkSize: 10,
    parallelUploads: 5,
    compressionLevel: 1,
  },
};
