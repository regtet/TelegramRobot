require('dotenv').config();

module.exports = {
  // Telegram Bot Token
  botToken: process.env.BOT_TOKEN,

  // Telegram 群组 ID
  chatId: process.env.CHAT_ID,

  // WG-WEB 项目路径
  buildProjectPath: process.env.BUILD_PROJECT_PATH || '../WG-WEB',

  // 允许的用户 ID 列表
  allowedUsers: process.env.ALLOWED_USERS
    ? process.env.ALLOWED_USERS.split(',').map(id => id.trim())
    : [],

  // 构建配置
  build: {
    // 构建命令
    buildCommand: 'npm run build',

    // 构建输出目录
    distPath: 'dist',

    // 压缩文件存放目录
    zipOutputPath: './builds',

    // 是否在打包前自动 npm install（关闭可节省1-2分钟）
    autoInstall: false,

    // 是否自动拉取最新代码（如果网络不稳定，可以设为 false）
    autoFetchPull: true,

    // 允许的分支列表（留空则允许所有分支）
    allowedBranches: [], // 例如: ['main', 'dev', 'release']

    // 是否严格过滤消息（只处理符合分支名格式的消息）
    strictMessageFilter: true,

    // 文件分片配置
    enableFileSplit: false,  // 关闭分片，上传完整文件
    splitSizeThreshold: 20,  // 超过此大小（MB）才分片
    chunkSize: 10,  // 每片大小（MB）
    parallelUploads: 5,  // 并行上传数量

    // 压缩配置
    compressionLevel: 1  // 压缩级别 (1-9: 1最快/文件大, 9最慢/文件小, 推荐6)
  }
};

