const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const chalk = require('chalk');
const config = require('./config');
const Builder = require('./builder');

// 验证配置
if (!config.botToken) {
  console.error(chalk.red('错误: 未设置 BOT_TOKEN，请在 .env 文件中配置'));
  process.exit(1);
}

// 创建 bot 实例
const bot = new TelegramBot(config.botToken, { polling: true });
const builder = new Builder(config.buildProjectPath, config.build);

console.log(chalk.green('✓ Telegram Bot 已启动'));
console.log(chalk.gray('项目路径:'), config.buildProjectPath);
console.log(chalk.gray('等待命令...\n'));

// 检查用户权限
function isUserAllowed(userId) {
  if (config.allowedUsers.length === 0) {
    return true; // 没有设置限制，允许所有人
  }
  return config.allowedUsers.includes(userId.toString());
}

// 检查分支是否允许
function isBranchAllowed(branchName) {
  if (config.build.allowedBranches.length === 0) {
    return true; // 没有设置限制，允许所有分支
  }
  return config.build.allowedBranches.includes(branchName);
}

// 处理消息
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name;
  const text = msg.text?.trim();

  // 打印用户信息（用于配置）
  console.log(chalk.gray('收到消息:'));
  console.log(chalk.gray('  用户ID:'), userId);
  console.log(chalk.gray('  用户名:'), username);
  console.log(chalk.gray('  群组ID:'), chatId);
  console.log(chalk.gray('  消息:'), text);

  // 如果还没配置 CHAT_ID，提示用户
  if (!config.chatId) {
    console.log(chalk.yellow('\n⚠ 提示: 请将上面的群组ID复制到 .env 文件的 CHAT_ID 中\n'));
  }

  if (!text) return;

  // 移除 bot 用户名（群组中命令会是 /command@botname）
  const cleanText = text.split('@')[0];

  // 命令: /start
  if (cleanText === '/start') {
    bot.sendMessage(chatId,
      `🤖 WG-WEB 自动打包机器人\n\n` +
      `使用方法:\n` +
      `1️⃣ 发送分支名开始打包，例如: main\n` +
      `2️⃣ 等待打包完成\n` +
      `3️⃣ 接收打包文件\n\n` +
      `命令列表:\n` +
      `/start - 显示帮助\n` +
      `/branches - 查看可用分支\n` +
      `/status - 查看配置状态`
    );
    return;
  }

  // 命令: /status
  if (cleanText === '/status') {
    const status =
      `📊 配置状态\n\n` +
      `✅ Bot Token: 已配置\n` +
      `${config.chatId ? '✅' : '❌'} 群组 ID: ${config.chatId || '未配置'}\n` +
      `✅ 项目路径: ${config.buildProjectPath}\n` +
      `✅ 用户限制: ${config.allowedUsers.length > 0 ? config.allowedUsers.join(', ') : '无限制'}\n` +
      `✅ 分支限制: ${config.build.allowedBranches.length > 0 ? config.build.allowedBranches.join(', ') : '无限制'}`;

    bot.sendMessage(chatId, status);
    return;
  }

  // 命令: /branches
  if (cleanText === '/branches') {
    bot.sendMessage(chatId, '🔍 正在获取分支列表...');

    try {
      const branches = await builder.getBranches();

      // 限制显示数量，避免消息太长
      const maxShow = 50;
      const displayBranches = branches.slice(0, maxShow);
      const branchList = displayBranches.map((b, i) => `${i + 1}. ${b}`).join('\n');

      let message = `📋 可用分支 (显示前 ${displayBranches.length} 个):\n\n${branchList}`;

      if (branches.length > maxShow) {
        message += `\n\n... 还有 ${branches.length - maxShow} 个分支未显示`;
      }

      message += '\n\n💡 直接发送分支名开始打包';

      bot.sendMessage(chatId, message);
    } catch (error) {
      bot.sendMessage(chatId, `❌ 获取分支失败: ${error.message}`);
    }
    return;
  }

  // 忽略其他以 / 开头的未知命令
  if (cleanText.startsWith('/')) {
    return;
  }

  // 处理分支名（开始打包）
  const branchName = text;

  // 检查用户权限
  if (!isUserAllowed(userId)) {
    bot.sendMessage(chatId, `❌ 抱歉，你没有权限使用此功能\n用户ID: ${userId}`);
    console.log(chalk.red(`拒绝访问: 用户 ${username} (${userId}) 无权限`));
    return;
  }

  // 检查分支限制
  if (!isBranchAllowed(branchName)) {
    bot.sendMessage(chatId,
      `❌ 分支 "${branchName}" 不在允许列表中\n\n` +
      `允许的分支: ${config.build.allowedBranches.join(', ')}`
    );
    return;
  }

  // 开始打包流程
  console.log(chalk.cyan(`\n开始打包分支: ${branchName}`));
  console.log(chalk.gray(`触发用户: ${username} (${userId})\n`));

  // 发送开始消息
  const startMsg = await bot.sendMessage(chatId,
    `🚀 开始打包\n\n` +
    `📦 分支: ${branchName}\n` +
    `👤 触发者: ${username}\n` +
    `⏰ 时间: ${new Date().toLocaleString('zh-CN')}\n\n` +
    `⏳ 正在处理...`
  );

  // 执行构建
  const result = await builder.fullBuild(branchName);

  if (result.success) {
    // 构建成功，发送文件
    const successMsg =
      `✅ 打包成功！\n\n` +
      `📦 分支: ${result.branchName}\n` +
      `💾 大小: ${result.sizeMB} MB\n` +
      `⏱ 构建耗时: ${result.buildDuration}s\n` +
      `⏱ 总耗时: ${result.totalDuration}s\n` +
      `📝 最新提交: ${result.commitInfo}\n` +
      `⏰ 完成时间: ${new Date().toLocaleString('zh-CN')}`;

    await bot.sendMessage(chatId, successMsg);

    // 发送文件
    console.log(chalk.cyan('📤 正在发送文件...'));

    try {
      await bot.sendDocument(chatId, result.zipFilePath, {
        caption: `📦 ${result.zipFileName}`
      });

      console.log(chalk.green('✓ 文件发送成功\n'));

      // 删除本地 zip 文件（可选）
      fs.unlinkSync(result.zipFilePath);
      console.log(chalk.gray('本地文件已清理\n'));

    } catch (error) {
      console.error(chalk.red('文件发送失败:'), error.message);
      bot.sendMessage(chatId, `❌ 文件发送失败: ${error.message}`);
    }

  } else {
    // 构建失败
    const errorMsg =
      `❌ 打包失败\n\n` +
      `📦 分支: ${branchName}\n` +
      `❗ 错误: ${result.error}\n` +
      `⏰ 时间: ${new Date().toLocaleString('zh-CN')}`;

    await bot.sendMessage(chatId, errorMsg);
  }
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

