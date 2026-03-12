const TelegramBot = require('node-telegram-bot-api');
const chalk = require('chalk');
const { SocksProxyAgent } = require('socks-proxy-agent');
const config = require('./config');

// 验证配置
if (!config.botToken) {
  console.error(chalk.red('错误: 未设置 BOT_TOKEN，请在 .env 文件中配置'));
  process.exit(1);
}

// 创建 bot 实例（支持和用户机器人一样走代理）
const botOptions = { polling: true };

if (process.env.PROXY_HOST && process.env.PROXY_PORT) {
  const socksType = parseInt(process.env.PROXY_TYPE, 10) || 5; // 默认 SOCKS5
  const protocol = socksType === 4 ? 'socks4' : 'socks5';

  const auth =
    process.env.PROXY_USER && process.env.PROXY_PASS
      ? `${encodeURIComponent(process.env.PROXY_USER)}:${encodeURIComponent(process.env.PROXY_PASS)}@`
      : '';

  const proxyUrl = `${protocol}://${auth}${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`;
  const agent = new SocksProxyAgent(proxyUrl);

  botOptions.request = { agent };
  console.log(chalk.yellow(`Bot 使用代理: ${proxyUrl}`));
}

const bot = new TelegramBot(config.botToken, botOptions);

console.log(chalk.green('✓ Telegram Bot 已启动（监听模式，无业务功能）'));
console.log(chalk.gray('等待群组消息...\n'));

// 监听模式：只打印群组中的消息，不做任何回复或业务处理
bot.on('message', (msg) => {
  const chatId = msg.chat?.id;
  const chatTitle = msg.chat?.title || msg.chat?.username || '';
  const userId = msg.from?.id;
  const username = msg.from?.username || msg.from?.first_name || '';
  const text = msg.text ?? '';

  // 如果配置了 CHAT_ID，则只关注指定群组
  if (config.chatId && chatId?.toString() !== config.chatId.toString()) {
    return;
  }

  console.log(chalk.gray('收到群组消息 (Bot 监听中):'));
  console.log(chalk.gray('  群组ID  :'), chatId);
  if (chatTitle) {
    console.log(chalk.gray('  群组名  :'), chatTitle);
  }
  console.log(chalk.gray('  用户ID  :'), userId);
  console.log(chalk.gray('  用户名  :'), username);
  console.log(chalk.gray('  文本内容:'), text);
  console.log();
});

// 错误处理
bot.on('polling_error', (error) => {
  console.error(chalk.red('Polling 错误:'), error.message);
});

// 优雅退出
process.on('SIGINT', () => {
  console.log(chalk.yellow('\n正在关闭 Bot...'));
  bot.stopPolling();
  process.exit(0);
});

