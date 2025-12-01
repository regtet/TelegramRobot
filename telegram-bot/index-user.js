const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const input = require('input');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const config = require('./config');
const Builder = require('./builder');
const FileSplitter = require('./file-splitter');

// 验证配置
if (!process.env.API_ID || !process.env.API_HASH) {
    console.error(chalk.red('错误: 未设置 API_ID 或 API_HASH'));
    console.error(chalk.yellow('请访问 https://my.telegram.org/apps 获取'));
    process.exit(1);
}

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const phoneNumber = process.env.PHONE_NUMBER;
const chatId = process.env.CHAT_ID ? BigInt(process.env.CHAT_ID) : null;

// Session 文件路径
const sessionFile = path.join(__dirname, 'session.txt');
let stringSession = '';

// 读取已保存的 session
if (fs.existsSync(sessionFile)) {
    stringSession = fs.readFileSync(sessionFile, 'utf8').trim();
    console.log(chalk.green('✓ 找到已保存的会话'));
}

// 代理配置（如果需要）
const clientOptions = {
    connectionRetries: 5,
};

// 如果配置了代理
if (process.env.PROXY_HOST && process.env.PROXY_PORT) {
    clientOptions.proxy = {
        socksType: parseInt(process.env.PROXY_TYPE) || 5, // 5 = SOCKS5
        ip: process.env.PROXY_HOST,
        port: parseInt(process.env.PROXY_PORT),
        username: process.env.PROXY_USER || undefined,
        password: process.env.PROXY_PASS || undefined,
    };
    console.log(chalk.yellow(`使用代理: ${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`));
}

const client = new TelegramClient(
    new StringSession(stringSession),
    apiId,
    apiHash,
    clientOptions
);

const builder = new Builder(config.buildProjectPath, config.build);

// 打包状态锁
// 构建状态管理
let isBuilding = false;
let currentBuildBranch = '';
let buildQueue = []; // 排队列表
let currentBuildId = null; // 当前构建ID
let shouldCancelBuild = false; // 取消标志

// 检查用户权限
function isUserAllowed(userId) {
    if (config.allowedUsers.length === 0) {
        return true;
    }
    return config.allowedUsers.includes(userId.toString());
}

// 检查分支是否允许
function isBranchAllowed(branchName) {
    if (config.build.allowedBranches.length === 0) {
        return true;
    }
    return config.build.allowedBranches.includes(branchName);
}

// 启动客户端
(async () => {
    console.log(chalk.cyan('正在连接 Telegram...'));

    await client.start({
        phoneNumber: async () => phoneNumber || await input.text('请输入手机号（带国家码，如 +86）: '),
        password: async () => await input.text('请输入两步验证密码（如果有）: '),
        phoneCode: async () => await input.text('请输入验证码: '),
        onError: (err) => console.log(chalk.red(err)),
    });

    console.log(chalk.green('✓ 已连接到 Telegram'));

    // 保存 session
    const session = client.session.save();
    fs.writeFileSync(sessionFile, session);
    console.log(chalk.green('✓ 会话已保存'));

    // 获取当前用户信息
    const me = await client.getMe();
    console.log(chalk.cyan(`已登录: ${me.firstName} (${me.username || me.phone})`));

    if (!chatId) {
        console.log(chalk.yellow('\n⚠ 未配置 CHAT_ID'));
        console.log(chalk.yellow('请在 .env 中配置目标群组 ID'));
        console.log(chalk.gray('获取方法：在任意群组发送消息，查看控制台输出\n'));
    } else {
        console.log(chalk.green(`✓ 目标群组: ${chatId}`));
    }

    console.log(chalk.gray('\n等待命令...\n'));

    // 监听新消息
    client.addEventHandler(async (event) => {
        try {
            const message = event.message;

            // 只处理文本消息
            if (!message || !message.text) return;

            const text = message.text.trim();
            const senderId = message.senderId.toString();
            const chatIdStr = message.chatId.toString();

            // 打印消息信息
            console.log(chalk.gray('收到消息:'));
            console.log(chalk.gray('  发送者ID:'), senderId);
            console.log(chalk.gray('  群组ID:'), chatIdStr);
            console.log(chalk.gray('  消息:'), text);

            // 如果配置了 CHAT_ID，只处理该群组的消息
            if (chatId && message.chatId.toString() !== chatId.toString()) {
                return;
            }

            // 移除 bot 用户名
            const cleanText = text.split('@')[0];

            // 命令: /start
            if (cleanText === '/start') {
                console.log(chalk.gray('收到 /start 命令'));
                console.log(
                    `🤖 WG-WEB 自动打包机器人\n\n` +
                    `使用方法:\n` +
                    `1️⃣ 打包单个分支:\n` +
                    `   打包 V5futebol\n` +
                    `   打包 x-12\n\n` +
                    `2️⃣ 打包多个分支（空格隔开）:\n` +
                    `   打包 V5futebol x-12 main\n` +
                    `   打包 a b c\n\n` +
                    `取消打包:\n` +
                    `取消 V5futebol\n` +
                    `取消打包 LF-Viagem\n\n` +
                    `命令:\n` +
                    `/queue - 查看队列\n` +
                    `/branches - 查看分支\n` +
                    `/status - 查看状态`
                );
                return;
            }

            // 命令: /status
            if (cleanText === '/status') {
                const status =
                    `📊 配置状态\n\n` +
                    `✅ API ID: ${apiId}\n` +
                    `✅ 手机号: ${phoneNumber || '未配置'}\n` +
                    `${chatId ? '✅' : '❌'} 群组 ID: ${chatId || '未配置'}\n` +
                    `✅ 项目路径: ${config.buildProjectPath}\n` +
                    `✅ 用户限制: ${config.allowedUsers.length > 0 ? config.allowedUsers.join(', ') : '无限制'}\n` +
                    `✅ 分支限制: ${config.build.allowedBranches.length > 0 ? config.build.allowedBranches.join(', ') : '无限制'}\n` +
                    `✅ 自动拉取: ${config.build.autoFetchPull ? '是' : '否'}`;

                console.log(chalk.gray('/status 命令输出:\n' + status));
                return;
            }

            // 命令: /branches
            if (cleanText === '/branches') {
                console.log(chalk.gray('收到 /branches 命令，正在获取分支列表...'));

                try {
                    const branches = await builder.getBranches();

                    const maxShow = 50;
                    const displayBranches = branches.slice(0, maxShow);
                    const branchList = displayBranches.map((b, i) => `${i + 1}. ${b}`).join('\n');

                    let msg = `📋 可用分支 (显示前 ${displayBranches.length} 个):\n\n${branchList}`;

                    if (branches.length > maxShow) {
                        msg += `\n\n... 还有 ${branches.length - maxShow} 个分支未显示`;
                    }

                    msg += '\n\n💡 直接发送分支名开始打包';

                    console.log(chalk.gray(msg));
                } catch (error) {
                    console.error(chalk.red(`获取分支失败: ${error.message}`));
                }
                return;
            }

            // 命令: /queue
            if (cleanText === '/queue') {
                let queueMessage = '📋 队列状态\n\n';

                if (isBuilding) {
                    queueMessage += `🔄 ${currentBuildBranch}\n\n`;
                } else {
                    queueMessage += `✅ 空闲\n\n`;
                }

                if (buildQueue.length > 0) {
                    queueMessage += `等待中 (${buildQueue.length}个):\n`;
                    buildQueue.forEach((item, index) => {
                        queueMessage += `${index + 1}. ${item.branchName}\n`;
                    });
                } else {
                    queueMessage += `等待中: 无`;
                }

                console.log(chalk.gray('/queue 命令输出:\n' + queueMessage));
                return;
            }

            // 命令: /cancel（已废弃，保留兼容）
            if (cleanText === '/cancel') {
                console.log(chalk.gray('收到 /cancel 命令（已废弃）'));
                console.log(
                    `ℹ️ 命令已更新\n\n` +
                    `新用法:\n` +
                    `取消 分支名 - 取消指定分支的打包\n` +
                    `取消打包 分支名 - 取消指定分支的打包\n\n` +
                    `示例:\n` +
                    `取消 V5futebol\n` +
                    `取消打包 LF-Viagem`
                );
                return;
            }

            // 忽略其他命令
            if (cleanText.startsWith('/')) {
                return;
            }

            // 消息过滤
            const trimmedText = text.trim();

            // 检查是否是"取消"或"取消打包"命令
            if (trimmedText.startsWith('取消打包')) {
                const branchName = trimmedText.substring(4).trim();

                if (branchName.length === 0) {
                    console.log(chalk.yellow('取消打包命令缺少分支名'));
                    return;
                }

                await handleCancelBranch(branchName, senderId, message.chatId);
                return;
            }

            if (trimmedText.startsWith('取消')) {
                const branchName = trimmedText.substring(2).trim();

                if (branchName.length === 0) {
                    console.log(chalk.yellow('取消命令缺少分支名'));
                    return;
                }

                await handleCancelBranch(branchName, senderId, message.chatId);
                return;
            }

            // 检查是否以"打包"开头
            if (!trimmedText.startsWith('打包')) {
                return; // 不是打包命令，忽略
            }

            // 提取分支名（去掉"打包"前缀），支持多个分支用空格或换行隔开
            const branchText = trimmedText.substring(2).trim();

            if (branchText.length === 0) {
                console.log(chalk.yellow('打包命令缺少分支名'));
                return;
            }

            // 按空格或换行符分割多个分支，并清理不可见字符
            const branchNames = branchText
                .split(/[\s\n\r]+/)  // 支持空格、换行符、回车符
                .filter(b => b.length > 0)
                .map(b => {
                    // 清理不可见字符（零宽字符、零宽非断行空格等）
                    return b.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '').trim();
                })
                .filter(b => b.length > 0);

            if (branchNames.length === 0) {
                console.log(chalk.yellow('打包命令未解析到有效分支名'));
                return;
            }

            // 验证每个分支名
            const invalidFormatBranches = [];
            for (const branchName of branchNames) {
                if (branchName.length > 100) {
                    invalidFormatBranches.push(`${branchName} (太长)`);
                } else if (!/^[a-zA-Z0-9\-_\/\.]+$/.test(branchName)) {
                    invalidFormatBranches.push(`${branchName} (非法字符)`);
                }
            }

            if (invalidFormatBranches.length > 0) {
                console.log(chalk.red(`分支名格式错误: ${invalidFormatBranches.join(', ')}`));
                return;
            }

            // 检查用户权限（只检查一次）
            if (!isUserAllowed(senderId)) {
                console.log(chalk.red(`拒绝访问: 用户 ${senderId} 无权限`));
                return;
            }

            // 检查分支权限（只检查一次）
            if (config.build.allowedBranches.length > 0) {
                const disallowedBranches = branchNames.filter(b => !isBranchAllowed(b));
                if (disallowedBranches.length > 0) {
                    console.log(chalk.red(`分支不允许打包: ${disallowedBranches.join(', ')}`));
                    return;
                }
            }

            // 验证分支是否存在
            console.log(chalk.cyan(`\n🔍 验证分支是否存在...`));
            const { valid: validBranches, invalid: invalidBranches } = await builder.validateBranches(branchNames);

            if (invalidBranches.length > 0) {
                console.log(chalk.yellow(`⚠ 以下分支不存在，将跳过: ${invalidBranches.join(', ')}`));
            }

            if (validBranches.length === 0) {
                console.log(chalk.red(`❌ 所有分支都不存在，取消打包`));
                try {
                    await client.sendMessage(message.chatId, {
                        message: `❌ 所有分支都不存在，取消打包`
                    });
                } catch (error) {
                    console.log(chalk.yellow('发送消息失败:', error.message));
                }
                return;
            }

            console.log(chalk.green(`✓ 有效分支: ${validBranches.join(', ')}`));
            console.log(chalk.cyan(`输入 有效分支: ${validBranches.join(', ')} 打包中...`));

            // 过滤掉已在队列中或正在打包的分支
            const newBranches = [];
            const duplicateBranches = [];

            for (const branchName of validBranches) {
                // 检查是否正在打包
                if (isBuilding && currentBuildBranch === branchName) {
                    duplicateBranches.push(`${branchName} (正在打包)`);
                    continue;
                }

                // 检查是否已在队列中
                const inQueue = buildQueue.some(item => item.branchName === branchName);
                if (inQueue) {
                    duplicateBranches.push(`${branchName} (已在队列)`);
                    continue;
                }

                newBranches.push(branchName);
            }

            // 如果有重复的分支，发送提示
            if (duplicateBranches.length > 0) {
                try {
                    await client.sendMessage(message.chatId, {
                        message: `⚠️ 以下分支已存在，已跳过:\n${duplicateBranches.join('\n')}`
                    });
                } catch (error) {
                    console.log(chalk.yellow('发送消息失败:', error.message));
                }
            }

            // 如果没有新分支需要处理，直接返回
            if (newBranches.length === 0) {
                console.log(chalk.yellow('所有分支都已存在，无需重复添加'));
                return;
            }

            // 发送消息到 Telegram（只输出一次，只包含新分支）
            try {
                const logMessage =
                    `🚀 打包任务启动\n` +
                    `📋 分支列表: ${newBranches.join(', ')}\n` +
                    `⏳ 正在处理中...`;

                await client.sendMessage(message.chatId, {
                    message: logMessage
                });
            } catch (error) {
                console.log(chalk.yellow('发送消息失败:', error.message));
            }

      // 处理多个分支（只处理新的有效分支）

            for (let i = 0; i < newBranches.length; i++) {
                const branchName = newBranches[i];
                const buildId = Date.now().toString() + '_' + i;

                if (isBuilding || (i > 0)) {
                    buildQueue.push({
                        buildId,
                        branchName,
                        userId: senderId,
                        chatId: message.chatId,
                        timestamp: new Date()
                    });
                    console.log(chalk.gray(`加入队列: ${branchName} (位置 ${buildQueue.length})`));
                    continue;
                }

                // 设置打包状态
                isBuilding = true;
                currentBuildBranch = branchName;
                currentBuildId = buildId;

                console.log(chalk.cyan(`\n开始打包分支: ${branchName} (共${validBranches.length}个)`));
                console.log(chalk.gray(`触发用户: ${senderId}\n`));

                // 执行构建流程（异步，不等待）
                (async () => {
                    try {
                        await executeBuild(branchName, senderId, message.chatId);
                    } catch (error) {
                        console.error(chalk.red('打包失败:'), error);
                    }

                    // 释放打包状态并处理下一个
                    isBuilding = false;
                    currentBuildBranch = '';
                    currentBuildId = null;

                    setTimeout(() => {
                        processNextInQueue();
                    }, 2000);
                })();
            }

      return;

        } catch (error) {
            console.error(chalk.red('处理消息时出错:'), error);
        }
    }, new NewMessage({}));

    // 处理取消指定分支
    async function handleCancelBranch(branchName, senderId, chatId) {
        let removedFromQueue = 0;

        if (isBuilding && currentBuildBranch === branchName) {
            shouldCancelBuild = true;
            console.log(chalk.yellow(`打包已中断: ${branchName} (操作者: ${senderId})`));
        }

        const originalLength = buildQueue.length;
        buildQueue = buildQueue.filter(task => {
            if (task.branchName === branchName) {
                removedFromQueue++;
                return false;
            }
            return true;
        });

        if (removedFromQueue > 0) {
            console.log(chalk.yellow(`从队列移除: ${branchName} (${removedFromQueue}个)`));
        }

        if (!shouldCancelBuild && removedFromQueue === 0) {
            console.log(chalk.gray(`取消请求未找到对应任务: ${branchName}`));
        }
    }

    // 执行构建流程（可复用函数）
    async function executeBuild(branchName, senderId, chatId) {
        shouldCancelBuild = false;

        const log = (...args) => console.log(chalk.blue(`[${branchName}]`), ...args);

        const updateProgress = async (stage, percent, msg) => {
            if (shouldCancelBuild) return;
            const text = msg || stage || '';
            if (percent === 100 || percent % 20 === 0) {
                log(`${percent}%`, text);
            }
        };

        const result = await builder.fullBuild(branchName, updateProgress);

        if (shouldCancelBuild) {
            log(chalk.yellow('任务已中断'));
            if (result?.zipFilePath && fs.existsSync(result.zipFilePath)) {
                fs.unlinkSync(result.zipFilePath);
            }
            return { cancelled: true };
        }

        if (!result.success) {
            log(chalk.red(`构建失败: ${result.error}`));
            return { cancelled: false };
        }

        log('构建完成，开始上传...');

        if (shouldCancelBuild) {
            log(chalk.yellow('上传前取消'));
            if (fs.existsSync(result.zipFilePath)) {
                fs.unlinkSync(result.zipFilePath);
            }
            return { cancelled: true };
        }

        try {
            await client.sendFile(chatId, {
                file: result.zipFilePath,
                forceDocument: true,
            });
            log(chalk.green('上传完成'));
        } catch (error) {
            log(chalk.red('上传失败'), error.message);
        } finally {
            if (fs.existsSync(result.zipFilePath)) {
                fs.unlinkSync(result.zipFilePath);
                log('已清理临时文件');
            }
        }

        return { cancelled: false };
    }

    // 处理队列中的下一个任务
    async function processNextInQueue() {
        if (buildQueue.length === 0) {
            return;
        }

        const nextTask = buildQueue.shift();
        console.log(chalk.cyan(`\n📋 处理队列任务: ${nextTask.branchName} (剩余 ${buildQueue.length}个)`));

        // 设置当前构建
        isBuilding = true;
        currentBuildBranch = nextTask.branchName;
        currentBuildId = nextTask.buildId;

        // 开始构建流程（不单独发消息，直接开始）
        try {
            await executeBuild(nextTask.branchName, nextTask.userId, nextTask.chatId);
        } catch (error) {
            console.error(chalk.red('队列任务处理失败:'), error);
        }

        // 重置状态并处理下一个
        isBuilding = false;
        currentBuildBranch = '';
        currentBuildId = null;

        setTimeout(() => {
            processNextInQueue();
        }, 2000);
    }

})();

// 优雅退出
process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n正在断开连接...'));
    await client.disconnect();
    process.exit(0);
});

