const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const input = require('input');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const chalk = require('chalk');
const axios = require('axios');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const { spawn } = require('child_process');

// 显式加载当前目录下的 .env，确保 AWS_* 等环境变量可用
dotenv.config({ path: path.join(__dirname, '.env') });

const config = require('./config');
const Builder = require('./builder');
const FileSplitter = require('./file-splitter');
const { extractBranchNameFromFileName, readPackageIdFromBranch } = require('./config-reader');

// 是否启用“收到群消息自动打开 LX Music”功能
// 需要时把这个改成 true，不需要时改回 false
// const ENABLE_LX_MUSIC_ON_MESSAGE = true;
const ENABLE_LX_MUSIC_ON_MESSAGE = false;

// LX Music 桌面版路径（请确保路径存在）
const LX_MUSIC_PATH = 'D:\\Music\\lx-music-desktop\\lx-music-desktop.exe';

// 简单防抖：避免短时间内反复打开
let lastLaunchTime = 0;
const LAUNCH_DEBOUNCE_MS = 10000; // 10 秒内只触发一次

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

// 多项目支持：WG-WEB（主仓库） + WGAME-WEB（备用仓库）
const projectAPath = config.buildProjectPath; // 例如 ../WG-WEB
const projectBPath = process.env.BUILD_PROJECT_PATH_B
    ? path.resolve(__dirname, process.env.BUILD_PROJECT_PATH_B)
    : null;

const builderA = new Builder(projectAPath, config.build); // WG-WEB
const builderB = projectBPath ? new Builder(projectBPath, config.build) : null;

// 默认 builder 保持为 WG-WEB，用于旧逻辑（检测 / 构建队列等）
const builder = builderA;

const projects = [
    { name: 'WG-WEB', builder: builderA, path: projectAPath },
    ...(builderB ? [{ name: 'WGAME-WEB', builder: builderB, path: projectBPath }] : []),
];

// S3 配置
const S3_REGION = process.env.AWS_REGION || 'sa-east-1';
const S3_BUCKET = process.env.S3_BUCKET || 'gulu3';

const s3Client = new S3Client({
    region: S3_REGION,
    credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    } : undefined,
});

// 打包状态锁
// 构建状态管理
let isBuilding = false;
let currentBuildBranch = '';
let buildQueue = []; // 普通打包（zip）排队列表
let currentBuildId = null; // 当前构建ID
let shouldCancelBuild = false; // 取消标志

// APK 打包队列（按顺序执行，避免多条消息交错）
let isApkBuilding = false;
let apkBuildQueue = [];
let currentApkBuildBranch = '';
let currentApkBuildProjectName = '';
let currentApkBuildChatId = null;

// 文件处理队列
let isProcessingFile = false; // 是否正在处理文件
let fileProcessQueue = []; // 文件处理排队列表

// APK 按钮选择缓存：分支 -> { packageId, appName }
const pendingApkOptions = new Map();

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

            // 收到目标群消息时，按需自动打开 LX Music
            if (ENABLE_LX_MUSIC_ON_MESSAGE) {
                try {
                    const now = Date.now();
                    if (now - lastLaunchTime > LAUNCH_DEBOUNCE_MS) {
                        lastLaunchTime = now;
                        console.log(chalk.cyan('🎵 检测到群消息，尝试启动 LX Music...'));

                        const child = spawn(LX_MUSIC_PATH, {
                            detached: true,
                            stdio: 'ignore'
                        });
                        child.unref();
                    } else {
                        console.log(chalk.gray('LX Music 启动防抖中，短时间内不重复打开'));
                    }
                } catch (err) {
                    console.error(chalk.red('启动 LX Music 失败:'), err.message);
                }
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

            // 按钮触发：✅ 打包 APK - {branch}
            if (trimmedText.startsWith('✅ 打包 APK - ')) {
                const branchNameForApk = trimmedText.substring('✅ 打包 APK - '.length).trim();

                if (!branchNameForApk) {
                    console.log(chalk.yellow('打包 APK 按钮消息缺少分支名'));
                    return;
                }

                console.log(chalk.cyan(`收到按钮：打包 APK - 分支 ${branchNameForApk}`));
                await enqueueApkBuild(branchNameForApk, message.chatId);
                return;
            }

            // 按钮触发：❌ 不打包 - {branch}
            if (trimmedText.startsWith('❌ 不打包 - ')) {
                const branchNameForCancel = trimmedText.substring('❌ 不打包 - '.length).trim();

                if (!branchNameForCancel) {
                    console.log(chalk.yellow('不打包 APK 按钮消息缺少分支名'));
                    return;
                }

                console.log(chalk.cyan(`收到按钮：不打包 APK - 分支 ${branchNameForCancel}`));
                pendingApkOptions.delete(branchNameForCancel);

                try {
                    await client.sendMessage(message.chatId, {
                        message: `✅ 已取消分支 ${branchNameForCancel} 的 APK 打包。`,
                    });
                } catch (error) {
                    console.log(chalk.yellow('发送消息失败:', error.message));
                }

                return;
            }

            // 文本命令：打包APK 分支名（例如：打包APK wg-burgguer）
            if (trimmedText.startsWith('打包APK')) {
                const branchTextForApk = trimmedText.substring('打包APK'.length).trim();

                if (!branchTextForApk) {
                    console.log(chalk.yellow('打包APK 命令缺少分支名'));
                    try {
                        await client.sendMessage(message.chatId, {
                            message: '❌ 打包APK 命令缺少分支名\n\n用法: 打包APK wg-burgguer 或 打包APK a b c',
                        });
                    } catch (error) {
                        console.log(chalk.yellow('发送消息失败:', error.message));
                    }
                    return;
                }

                // 按空格或换行符分割多个分支，并清理不可见字符
                const apkBranchNames = branchTextForApk
                    .split(/[\s\n\r]+/)
                    .filter(b => b.length > 0)
                    .map(b => b.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '').trim())
                    .filter(b => b.length > 0);

                if (apkBranchNames.length === 0) {
                    console.log(chalk.yellow('打包APK 命令未解析到有效分支名'));
                    try {
                        await client.sendMessage(message.chatId, {
                            message: '❌ 打包APK 命令未解析到有效分支名',
                        });
                    } catch (error) {
                        console.log(chalk.yellow('发送消息失败:', error.message));
                    }
                    return;
                }

                console.log(chalk.cyan(`收到打包APK 命令，分支: ${apkBranchNames.join(', ')}`));

                // 逐个分支加入 APK 队列（由队列串行处理）
                for (const name of apkBranchNames) {
                    await enqueueApkBuild(name, message.chatId);
                }
                return;
            }

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

            // 检查是否是"检测"命令
            if (trimmedText.startsWith('检测')) {
                const branchText = trimmedText.substring(2).trim();

                if (branchText.length === 0) {
                    console.log(chalk.yellow('检测命令缺少分支名'));
                    try {
                        await client.sendMessage(message.chatId, {
                            message: `❌ 检测命令缺少分支名\n\n用法: 检测 分支名\n示例: 检测 45BB\n示例: 检测 67m coroa-ccddpg`
                        });
                    } catch (error) {
                        console.log(chalk.yellow('发送消息失败:', error.message));
                    }
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
                    console.log(chalk.yellow('检测命令未解析到有效分支名'));
                    try {
                        await client.sendMessage(message.chatId, {
                            message: `❌ 检测命令未解析到有效分支名`
                        });
                    } catch (error) {
                        console.log(chalk.yellow('发送消息失败:', error.message));
                    }
                    return;
                }

                // 验证每个分支名格式
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
                    try {
                        await client.sendMessage(message.chatId, {
                            message: `❌ 分支名格式错误: ${invalidFormatBranches.join(', ')}`
                        });
                    } catch (error) {
                        console.log(chalk.yellow('发送消息失败:', error.message));
                    }
                    return;
                }

                // 异步执行检测，不阻塞消息处理
                (async () => {
                    try {
                        await handleDetectBranches(branchNames, message.chatId);
                    } catch (error) {
                        console.error(chalk.red('检测分支失败:'), error);
                        try {
                            await client.sendMessage(message.chatId, {
                                message: `❌ 检测失败: ${error.message}`
                            });
                        } catch (err) {
                            console.log(chalk.yellow('发送消息失败:', err.message));
                        }
                    }
                })();
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

            // 验证分支是否存在（在 WG-WEB / WGAME-WEB 两个仓库中查找）
            console.log(chalk.cyan(`\n🔍 验证分支是否存在...`));
            const resolvedBuildTargets = [];
            const invalidBuildBranches = [];

            for (const name of branchNames) {
                try {
                    const resolved = await resolveProjectAndBranch(name);
                    if (resolved) {
                        resolvedBuildTargets.push({
                            inputName: name,
                            project: resolved.project,
                            actualBranchName: resolved.actualBranchName,
                        });
                    } else {
                        invalidBuildBranches.push(name);
                    }
                } catch (e) {
                    console.log(chalk.yellow(`在所有项目中验证分支 ${name} 失败: ${e.message}`));
                    invalidBuildBranches.push(name);
                }
            }

            if (invalidBuildBranches.length > 0) {
                console.log(chalk.yellow(`⚠ 以下分支在两个仓库中都不存在，将跳过: ${invalidBuildBranches.join(', ')}`));
                try {
                    await client.sendMessage(message.chatId, {
                        message: `⚠ 以下分支在两个仓库中都不存在，将跳过:\n${invalidBuildBranches.join(', ')}`
                    });
                } catch (error) {
                    console.log(chalk.yellow('发送消息失败:', error.message));
                }
            }

            if (resolvedBuildTargets.length === 0) {
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

            const validBranches = resolvedBuildTargets.map(t => t.actualBranchName);
            console.log(chalk.green(`✓ 有效分支: ${validBranches.join(', ')}`));
            console.log(chalk.cyan(`输入 有效分支: ${validBranches.join(', ')} 打包中...`));

            // 过滤掉已在队列中或正在打包的分支
            const newTargets = [];
            const duplicateBranches = [];

            for (const target of resolvedBuildTargets) {
                const branchName = target.actualBranchName;
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

                newTargets.push(target);
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
            if (newTargets.length === 0) {
                console.log(chalk.yellow('所有分支都已存在，无需重复添加'));
                return;
            }

            // 发送消息到 Telegram（只输出一次，只包含新分支）
            try {
                const logMessage =
                    `🚀 打包任务启动\n` +
                    `📋 分支列表: ${newTargets.map(t => t.actualBranchName).join(', ')}\n` +
                    `⏳ 正在处理中...`;

                await client.sendMessage(message.chatId, {
                    message: logMessage
                });
            } catch (error) {
                console.log(chalk.yellow('发送消息失败:', error.message));
            }

            // 处理多个分支（只处理新的有效分支）
            for (let i = 0; i < newTargets.length; i++) {
                const { project, actualBranchName } = newTargets[i];
                const branchName = actualBranchName;
                const buildId = Date.now().toString() + '_' + i;

                if (isBuilding || (i > 0)) {
                    buildQueue.push({
                        buildId,
                        branchName,
                        project,
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

                console.log(chalk.cyan(`\n开始打包项目 ${project.name} 中的分支: ${branchName} (共${validBranches.length}个)`));
                console.log(chalk.gray(`触发用户: ${senderId}\n`));

                // 执行构建流程（异步，不等待）
                (async () => {
                    try {
                        await executeBuild(project, branchName, senderId, message.chatId);
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

    // 监听文件上传（压缩包）
    client.addEventHandler(async (event) => {
        try {
            const message = event.message;

            // 只处理有文件的消息
            if (!message || !message.media) return;

            // 检查是否是文档类型（文件）
            const media = message.media;
            let fileName = null;
            let fileSize = 0;

            // 处理不同类型的媒体
            if (media.className === 'MessageMediaDocument') {
                const document = media.document;
                if (document && document.attributes) {
                    // 查找文件名属性
                    const fileNameAttr = document.attributes.find(attr => attr.className === 'DocumentAttributeFilename');
                    if (fileNameAttr) {
                        fileName = fileNameAttr.fileName;
                        fileSize = document.size || 0;
                    }
                }
            }

            // 如果没有文件名，跳过
            if (!fileName) return;

            // 如果配置了 CHAT_ID，只处理该群组的消息
            if (chatId && message.chatId.toString() !== chatId.toString()) {
                return;
            }

            // 从文件名提取分支名（函数内部会检查是否是压缩包）
            const branchName = extractBranchNameFromFileName(fileName);

            if (!branchName) {
                // 不是压缩包文件或无法提取分支名，静默跳过（不打印日志）
                return;
            }

            // 打印文件信息（只处理压缩包文件）
            console.log(chalk.gray('收到压缩包文件:'));
            console.log(chalk.gray('  文件名:'), fileName);
            console.log(chalk.gray('  大小:'), (fileSize / 1024 / 1024).toFixed(2), 'MB');

            console.log(chalk.cyan(`\n📦 检测到压缩包文件: ${fileName}`));
            console.log(chalk.cyan(`🔍 提取的分支名: ${branchName}`));

            // 验证分支是否存在
            console.log(chalk.cyan(`🔍 验证分支是否存在...`));

            // 清除缓存，确保获取最新分支列表
            builder._branchesCache = null;

            // 在 WG-WEB / WGAME-WEB 中解析实际项目和分支名
            const resolved = await resolveProjectAndBranch(branchName);
            const branchExists = !!resolved;
            const actualBranchName = resolved ? resolved.actualBranchName : branchName;

            if (!branchExists) {
                const errorMsg = `🔍 正在分析压缩包…\n📦 文件识别完成：${fileName}\n🌿 分支匹配成功：${branchName}\n🧠 云端代码库扫描中…\n❌ 云端未检测到分支：${branchName}`;
                console.log(chalk.red(`❌ 分支 ${branchName} 云端未检测到`));

                // 发送 Telegram 消息
                try {
                    await client.sendMessage(message.chatId, {
                        message: errorMsg,
                        parseMode: 'Markdown'
                    });
                } catch (error) {
                    // 如果 Markdown 解析失败，使用纯文本格式
                    try {
                        await client.sendMessage(message.chatId, {
                            message: `⚠️ 分支检测\n\n🌿 分支: ${branchName}\n❌ 云端未检测到该分支`
                        });
                    } catch (err) {
                        console.log(chalk.yellow('发送消息失败:', err.message));
                    }
                }
                return;
            }

            console.log(chalk.green(`✓ 分支 ${actualBranchName} 存在（项目: ${resolved.project.name}）`));

            // 将文件处理任务加入队列
            const fileTask = {
                fileName,
                branchName,
                actualBranchName,
                project: resolved.project,
                chatId: message.chatId,
                timestamp: new Date()
            };

            if (isProcessingFile || isBuilding) {
                fileProcessQueue.push(fileTask);
                console.log(chalk.gray(`📦 文件处理加入队列: ${fileName} (位置 ${fileProcessQueue.length})`));
                return;
            }

            // 立即处理文件
            (async () => {
                await processFileTask(fileTask);
            })();
        } catch (error) {
            console.error(chalk.red('处理文件消息时出错:'), error);
        }
    }, new NewMessage({}));

    // 处理文件任务（从队列中取出并处理）
    async function processFileTask(task) {
        const { fileName, branchName, actualBranchName, project, chatId } = task;

        // 设置处理状态
        isProcessingFile = true;

        try {
            // 如果正在构建，等待一小段时间（避免冲突）
            if (isBuilding) {
                console.log(chalk.yellow('⚠ 正在构建中，等待 2 秒后处理...'));
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            // 切换到该分支并拉取最新代码，确保读取的是远程最新配置
            const currentBranch = await project.builder.runCommand('git rev-parse --abbrev-ref HEAD');
            let originalBranch = currentBranch.success ? currentBranch.output.trim() : null;

            try {
                // 使用实际匹配到的分支名（可能大小写不同）
                const targetBranch = actualBranchName;

                // 如果目标分支就是当前分支，也需要拉取最新代码
                if (originalBranch === targetBranch) {
                    console.log(chalk.gray(`当前已在分支 ${targetBranch}，拉取最新代码...`));
                } else {
                    // 先 fetch 获取远程最新信息
                    if (config.build.autoFetchPull) {
                        console.log(chalk.cyan(`📥 [${project.name}] 获取远程分支信息...`));
                        const fetchResult = await project.builder.runCommand('git fetch --all');
                        if (!fetchResult.success) {
                            console.log(chalk.yellow(`⚠ Fetch 失败，继续尝试切换分支...`));
                        } else {
                            console.log(chalk.green(`✓ Fetch 完成`));
                        }
                    }

                    // 使用安全切换逻辑（自动清理未解决冲突 & 远程创建）
                    await safeCheckoutBranch(project, targetBranch);
                }

                // 拉取最新代码（确保读取的是远程最新配置）
                if (config.build.autoFetchPull) {
                    console.log(chalk.cyan(`📥 [${project.name}] 拉取分支最新代码...`));
                    const pullResult = await project.builder.runCommand('git pull');
                    if (!pullResult.success) {
                        console.log(chalk.yellow(`⚠ Pull 失败，使用本地代码: ${pullResult.error}`));
                    } else {
                        console.log(chalk.green(`✓ 代码已更新到最新`));
                    }
                }

                // 读取配置文件（现在读取的是最新代码）
                console.log(chalk.cyan(`📖 [${project.name}] 读取配置文件...`));
                const result = await readPackageIdFromBranch(project.path, actualBranchName);

                if (result.success) {
                    // 格式化 debug 信息
                    const debugText = result.debug !== undefined
                        ? (result.debug ? '测试游服' : '正式游服')
                        : '未知';
                    const debugEmoji = result.debug !== undefined
                        ? (result.debug ? '🧪' : '✅')
                        : '❓';
                    const debugValue = result.debug !== undefined
                        ? `debug: ${result.debug}`
                        : 'debug: 未检测到';

                    // App 名称（来自 appDownPath 最后一段）
                    const appName = result.appName || '未检测到';

                    // 域名反解析结果（主域名 / 备用域名）
                    const mainDomains = Array.isArray(result.mainDomains) ? result.mainDomains : [];
                    const backupDomains = Array.isArray(result.backupDomains) ? result.backupDomains : [];

                    let msg =
                        `🔍 正在分析压缩包…\n\n` +
                        `📦 文件名        : ${fileName}\n` +
                        `📁 项目          : ${project.name}\n` +
                        `🌿 分支          : ${actualBranchName}\n` +
                        `📋 Package ID    : ${result.packageId}\n` +
                        `📱 App 名称      : ${appName}\n` +
                        `🎮 游服类型      : ${debugText} (${debugValue})`;

                    if (mainDomains.length > 0 || backupDomains.length > 0) {
                        msg += `\n\n🌐 域名反解析结果\n`;
                        msg += `────────────────────────\n\n`;

                        if (mainDomains.length > 0) {
                            msg += `🔹 主域名\n`;
                            mainDomains.forEach(d => {
                                msg += `   • ${d}\n`;
                            });
                            if (backupDomains.length > 0) {
                                msg += `\n`;
                            }
                        }

                        if (backupDomains.length > 0) {
                            msg += `🔸 备用域名\n`;
                            backupDomains.forEach(b => {
                                const suffix = b && b.hidePhone ? '（隐藏手机号）' : '';
                                msg += `   • ${b.domain}${suffix}\n`;
                            });
                        }
                    }

                    console.log(
                        chalk.green(
                            `✅ 分支 ${actualBranchName} 当前分支分包ID packageId: ${result.packageId}, appName: ${appName}, debug: ${result.debug !== undefined ? result.debug : '未检测到'}`
                        )
                    );

                    // 缓存该分支的 APK 打包参数（用于按钮 / 文本命令触发）
                    pendingApkOptions.set(actualBranchName, {
                        packageId: result.packageId,
                        appName,
                        appNameSlug: result.appNameSlug,
                        primaryDomain: result.primaryDomain,
                    });

                    // 发送检测结果（不再自动加入 APK 打包队列）
                    try {
                        await client.sendMessage(chatId, {
                            message: msg,
                            parseMode: 'Markdown',
                        });
                    } catch (error) {
                        try {
                            await client.sendMessage(chatId, {
                                // Markdown 发送失败时，退回普通文本，但内容保持完全一致（包含域名反解析结果）
                                message: msg,
                            });
                        } catch (err) {
                            console.log(chalk.yellow('发送消息失败:', err.message));
                        }
                    }
                } else {
                    const errorMsg = `🔍 正在分析压缩包…\n📦 文件识别完成：${fileName}\n🌿 分支匹配成功：${actualBranchName}\n🧠 云端代码库扫描中…\n❌ 未检测到 packageId 配置`;
                    console.log(chalk.red(`❌ 分支 ${actualBranchName} 当前分支 未检测到packageId配置`));

                    // 发送 Telegram 消息
                    try {
                        await client.sendMessage(chatId, {
                            message: errorMsg,
                            parseMode: 'Markdown'
                        });
                    } catch (error) {
                        // 如果 Markdown 解析失败，使用纯文本格式
                        try {
                            await client.sendMessage(chatId, {
                                message: `⚠️ 配置检测\n\n🌿 分支: ${branchName}\n❌ 未检测到 packageId 配置`
                            });
                        } catch (err) {
                            console.log(chalk.yellow('发送消息失败:', err.message));
                        }
                    }
                }
            } catch (error) {
                console.error(chalk.red(`处理文件失败: ${error.message}`));

                // 发送错误消息
                try {
                    await client.sendMessage(chatId, {
                        message: `处理文件失败: ${error.message}`
                    });
                } catch (err) {
                    console.log(chalk.yellow('发送消息失败:', err.message));
                }
            } finally {
                // 这里不再自动恢复到原分支，保持当前处于处理过的分支，方便后续调试与操作
            }
        } finally {
            // 清理本地分支（保留 main）
            try {
                await cleanupLocalBranches();
            } catch (error) {
                console.log(chalk.yellow(`清理分支失败: ${error.message}`));
            }

            // 释放处理状态
            isProcessingFile = false;

            // 处理队列中的下一个文件
            if (fileProcessQueue.length > 0) {
                const nextFileTask = fileProcessQueue.shift();
                console.log(chalk.cyan(`\n📦 处理队列中的文件: ${nextFileTask.fileName} (剩余 ${fileProcessQueue.length}个)`));
                setTimeout(() => {
                    processFileTask(nextFileTask);
                }, 1000); // 延迟1秒处理下一个，避免冲突
            }
        }
    }

    // 上传本地文件到 S3
    async function uploadFileToS3(localFilePath, key, contentType = 'application/octet-stream') {
        if (!S3_BUCKET) {
            console.log(chalk.red('❌ 未配置 S3_BUCKET，无法上传到 S3'));
            throw new Error('S3_BUCKET 未配置');
        }

        if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
            console.log(chalk.red('❌ 未配置 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY，无法上传到 S3'));
            throw new Error('AWS 凭证未配置');
        }

        const maxAttempts = 10;
        const delayMs = 3000;
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            console.log(chalk.cyan(`📤 正在上传到 S3 (尝试 ${attempt}/${maxAttempts}): bucket=${S3_BUCKET}, key=${key}`));

            try {
                const fileStream = fs.createReadStream(localFilePath);

                const command = new PutObjectCommand({
                    Bucket: S3_BUCKET,
                    Key: key,
                    Body: fileStream,
                    ContentType: contentType,
                });

                // 为每次上传设置 60 秒超时，超时则主动中止本次请求并记为一次失败
                const abortController = new AbortController();
                const timeoutId = setTimeout(() => {
                    abortController.abort();
                }, 60000);

                try {
                    await s3Client.send(command, { abortSignal: abortController.signal });
                } finally {
                    clearTimeout(timeoutId);
                }

                console.log(chalk.green('✅ 上传到 S3 成功'));

                const publicUrl = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`;
                return { key, url: publicUrl };
            } catch (error) {
                lastError = error;
                const msg = (error && error.message) || '';

                console.log(chalk.yellow(`⚠ 上传到 S3 失败（第 ${attempt}/${maxAttempts} 次）：${msg}`));

                const isAbortError =
                    (error && error.name === 'AbortError') ||
                    /Request aborted/i.test(msg);

                const isAwsRequestTimeout =
                    (error && (error.Code === 'RequestTimeout' || error.name === 'RequestTimeout')) ||
                    /Your socket connection to the server was not read from or written to within the timeout period\. Idle connections will be closed\./i.test(msg);

                const retryable =
                    isAbortError ||
                    isAwsRequestTimeout ||
                    /Client network socket disconnected before secure TLS connection was established/i.test(msg) ||
                    /ECONNRESET/i.test(msg) ||
                    /ETIMEDOUT/i.test(msg) ||
                    /EAI_AGAIN/i.test(msg);

                if (!retryable || attempt === maxAttempts) {
                    break;
                }

                console.log(chalk.yellow(`⏳ ${delayMs / 1000} 秒后重试上传到 S3...`));
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        throw lastError || new Error('上传到 S3 失败（未知错误）');
    }

    // 清理本地分支（保留 main）
    async function cleanupLocalBranches() {
        console.log(chalk.cyan('🧹 清理本地分支（保留 main）...'));

        // 获取所有本地分支
        const branchesResult = await builder.runCommand('git branch');
        if (!branchesResult.success) {
            console.log(chalk.yellow('⚠ 获取分支列表失败'));
            return;
        }

        // 解析分支列表
        const branches = branchesResult.output
            .split('\n')
            .map(b => b.trim())
            .filter(b => b.length > 0 && !b.startsWith('*'))
            .filter(b => b !== 'main' && b !== 'master'); // 保留 main 和 master

        if (branches.length === 0) {
            console.log(chalk.gray('✓ 没有需要清理的分支'));
            return;
        }

        // 删除每个分支
        let deletedCount = 0;
        for (const branch of branches) {
            // 如果正在构建这个分支，跳过
            if (isBuilding && currentBuildBranch === branch) {
                console.log(chalk.gray(`跳过删除分支 ${branch}（正在构建中）`));
                continue;
            }

            const deleteResult = await builder.runCommand(`git branch -D ${branch}`);
            if (deleteResult.success) {
                deletedCount++;
                console.log(chalk.gray(`✓ 已删除分支: ${branch}`));
            } else {
                console.log(chalk.yellow(`⚠ 删除分支失败: ${branch} - ${deleteResult.error}`));
            }
        }

        if (deletedCount > 0) {
            console.log(chalk.green(`✓ 已清理 ${deletedCount} 个本地分支`));
        }
    }

    // 处理检测多个分支 Package ID（支持 WG-WEB + WGAME-WEB 两个仓库）
    async function handleDetectBranches(branchNames, chatId) {
        console.log(chalk.cyan(`\n🔍 开始检测分支: ${branchNames.join(', ')}`));

        // 发送开始检测消息
        try {
            await client.sendMessage(chatId, {
                message: `🔍 正在检测分支: ${branchNames.join(', ')}\n⏳ 请稍候...`
            });
        } catch (error) {
            console.log(chalk.yellow('发送消息失败:', error.message));
        }

        // 先在两个项目中解析每个分支所属的项目和实际分支名
        console.log(chalk.cyan(`🔍 在 WG-WEB / WGAME-WEB 中解析分支所属项目...`));

        const resolvedInfos = [];
        const invalidInfos = [];

        for (const name of branchNames) {
            try {
                const resolved = await resolveProjectAndBranch(name);
                if (resolved) {
                    resolvedInfos.push({
                        inputName: name,
                        project: resolved.project,
                        actualBranchName: resolved.actualBranchName,
                    });
                } else {
                    invalidInfos.push(name);
                }
            } catch (e) {
                console.log(chalk.yellow(`在所有项目中解析分支 ${name} 失败: ${e.message}`));
                invalidInfos.push(name);
            }
        }

        if (invalidInfos.length > 0) {
            console.log(chalk.yellow(`⚠ 以下分支在两个仓库中都不存在: ${invalidInfos.join(', ')}`));
        }

        if (resolvedInfos.length === 0) {
            const errorMsg = `❌ 所有分支都不存在: ${branchNames.join(', ')}`;
            console.log(chalk.red(errorMsg));
            try {
                await client.sendMessage(chatId, { message: errorMsg });
            } catch (error) {
                console.log(chalk.yellow('发送消息失败:', error.message));
            }
            return;
        }

        const results = [];

        try {
            // 逐个检测每个分支（注意：可能来自不同项目）
            for (let i = 0; i < resolvedInfos.length; i++) {
                const info = resolvedInfos[i];
                const { project, actualBranchName } = info;

                console.log(chalk.cyan(`\n[${i + 1}/${resolvedInfos.length}] 在项目 ${project.name} 中检测分支: ${actualBranchName}`));

                try {
                    // 1. 切换到对应项目的当前分支
                    const currentBranch = await project.builder.runCommand('git rev-parse --abbrev-ref HEAD');
                    let originalBranch = currentBranch.success ? currentBranch.output.trim() : null;

                    // 如果目标分支就是当前分支，也需要拉取最新代码
                    if (originalBranch === actualBranchName) {
                        console.log(chalk.gray(`当前已在项目 ${project.name} 的分支 ${actualBranchName}，拉取最新代码...`));
                    } else {
                        if (config.build.autoFetchPull) {
                            console.log(chalk.cyan(`📥 [${project.name}] 获取远程分支信息...`));
                            const fetchResult = await project.builder.runCommand('git fetch --all');
                            if (!fetchResult.success) {
                                console.log(chalk.yellow(`⚠ [${project.name}] Fetch 失败，继续尝试切换分支: ${fetchResult.error}`));
                            } else {
                                console.log(chalk.green(`✓ [${project.name}] Fetch 完成`));
                            }
                        }

                        // 使用安全切换逻辑（自动清理未解决冲突 & 远程创建）
                        await safeCheckoutBranch(project, actualBranchName);
                    }

                    // 2. 拉取最新代码
                    if (config.build.autoFetchPull) {
                        console.log(chalk.cyan(`📥 [${project.name}] 拉取分支最新代码...`));
                        const pullResult = await project.builder.runCommand('git pull');
                        if (!pullResult.success) {
                            console.log(chalk.yellow(`⚠ [${project.name}] Pull 失败，使用本地代码: ${pullResult.error}`));
                        } else {
                            console.log(chalk.green(`✓ [${project.name}] 代码已更新到最新`));
                        }
                    }

                    // 3. 读取配置文件
                    console.log(chalk.cyan(`📖 [${project.name}] 读取配置文件...`));
                    const result = await readPackageIdFromBranch(project.path, actualBranchName);

                    if (result.success) {
                        const debugText = result.debug !== undefined
                            ? (result.debug ? '测试游服' : '正式游服')
                            : '未知';
                        const debugEmoji = result.debug !== undefined
                            ? (result.debug ? '🧪' : '✅')
                            : '❓';
                        const debugValue = result.debug !== undefined
                            ? `debug: ${result.debug}`
                            : 'debug: 未检测到';

                        const appName = result.appName || '未检测到';

                        results.push({
                            projectName: project.name,
                            branchName: actualBranchName,
                            packageId: result.packageId,
                            appName,
                            debug: result.debug,
                            debugText,
                            debugEmoji,
                            debugValue,
                            mainDomains: Array.isArray(result.mainDomains) ? result.mainDomains : [],
                            backupDomains: Array.isArray(result.backupDomains) ? result.backupDomains : [],
                            success: true
                        });

                        console.log(
                            chalk.green(
                                `✅ [${project.name}] 分支 ${actualBranchName} 的 Package ID: ${result.packageId}, appName: ${appName}, debug: ${result.debug !== undefined ? result.debug : '未检测到'}`
                            )
                        );
                    } else {
                        results.push({
                            projectName: project.name,
                            branchName: actualBranchName,
                            success: false,
                            error: '未检测到 packageId 配置'
                        });
                        console.log(chalk.red(`❌ [${project.name}] 分支 ${actualBranchName} 未检测到 packageId 配置`));
                    }
                } catch (error) {
                    results.push({
                        projectName: project.name,
                        branchName: info.actualBranchName,
                        success: false,
                        error: error.message
                    });
                    console.error(chalk.red(`检测分支 ${info.actualBranchName} 失败: ${error.message}`));
                }

                // 每个分支检测完后清理一次 WG-WEB 的本地分支（可选）
                try {
                    await cleanupLocalBranches();
                } catch (error) {
                    console.log(chalk.yellow(`清理分支失败: ${error.message}`));
                }
            }

            // 汇总结果并发送消息
            const total = results.length;
            let msg = '';

            msg += '==================================================\n';
            msg += `🔍 批量检测完成（共 ${total} 个项目）\n`;
            msg += '==================================================\n\n\n';

            results.forEach((result, index) => {
                const idx = index + 1;
                msg += `【 ${idx} / ${total} 】━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

                if (result.success) {
                    msg += `📁 项目        : ${result.projectName}\n`;
                    msg += `🌿 分支        : ${result.branchName}\n`;
                    msg += `📋 Package ID  : ${result.packageId}\n`;
                    msg += `📱 App 名称     : ${result.appName}\n`;
                    msg += `🎮 游服类型     : ${result.debugText} (${result.debugValue})\n\n`;

                    const mainDomains = Array.isArray(result.mainDomains) ? result.mainDomains : [];
                    const backupDomains = Array.isArray(result.backupDomains) ? result.backupDomains : [];

                    if (mainDomains.length > 0 || backupDomains.length > 0) {
                        msg += `🌐 域名反解析结果\n`;
                        msg += `────────────────────────\n`;

                        if (mainDomains.length > 0) {
                            msg += `\n🔹 主域名\n`;
                            mainDomains.forEach(d => {
                                msg += `   • ${d}\n`;
                            });
                        }

                        if (backupDomains.length > 0) {
                            msg += `\n\n🔸 备用域名\n`;
                            backupDomains.forEach(b => {
                                const suffix = b && b.hidePhone ? '（隐藏手机号）' : '';
                                msg += `   • ${b.domain}${suffix}\n`;
                            });
                        }
                    }
                } else {
                    msg += `📁 项目        : ${result.projectName}\n`;
                    msg += `🌿 分支        : ${result.branchName}\n`;
                    msg += `❌ ${result.error}\n`;
                }

                msg += '\n\n';
            });

            if (invalidInfos.length > 0) {
                msg += `⚠ 以下分支在两个仓库中都未找到:\n${invalidInfos.join(', ')}\n\n`;
            }

            msg += '==================================================\n';
            msg += '✅ 所有项目检测完成\n';
            msg += '==================================================';

            try {
                await client.sendMessage(chatId, { message: msg });
            } catch (error) {
                console.log(chalk.yellow('发送消息失败:', error.message));
            }

        } catch (error) {
            console.error(chalk.red(`检测分支失败: ${error.message}`));

            try {
                await client.sendMessage(chatId, {
                    message: `❌ 检测失败: ${error.message}`
                });
            } catch (err) {
                console.log(chalk.yellow('发送消息失败:', err.message));
            }
        } finally {
            // 最后清理一次 WG-WEB 中的本地分支
            try {
                await cleanupLocalBranches();
            } catch (error) {
                console.log(chalk.yellow(`清理分支失败: ${error.message}`));
            }
        }
    }

    // 此处原本使用 CallbackQuery 事件处理内联按钮。
    // 由于当前 telegram 版本对 CallbackQuery 构造器支持存在兼容性问题，
    // 我们改用“回复键盘按钮 + 文本指令”方式，在 NewMessage 事件中完成打包逻辑。

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

    // 在多个项目中解析出对应的项目和分支名（先 WG-WEB，再 WGAME-WEB）
    async function resolveProjectAndBranch(branchName) {
        const trimmedBranch = (branchName || '').trim().replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '');
        if (!trimmedBranch) return null;

        for (const proj of projects) {
            // 清理项目的分支缓存，确保使用远程最新信息
            proj.builder._branchesCache = null;
            try {
                const { valid } = await proj.builder.validateBranches([trimmedBranch]);
                if (valid && valid.length > 0) {
                    return {
                        project: proj,
                        actualBranchName: valid[0],
                    };
                }

                // 当 fetch 失败导致分支列表陈旧时，用 ls-remote 单独查询该分支是否在远端存在
                const lsResult = await proj.builder.runCommand('git ls-remote origin ' + trimmedBranch);
                if (lsResult.success && lsResult.output && lsResult.output.includes('refs/heads/')) {
                    const m = lsResult.output.match(/refs\/heads\/(\S+)/);
                    const actualName = (m && m[1]) ? m[1].trim() : trimmedBranch;
                    console.log(chalk.cyan(`✓ [${proj.name}] 通过 ls-remote 确认远端分支存在: ${actualName}`));
                    return {
                        project: proj,
                        actualBranchName: actualName,
                    };
                }
            } catch (e) {
                console.log(chalk.yellow(`在项目 ${proj.name} 中验证分支 ${branchName} 失败: ${e.message}`));
            }
        }
        return null;
    }

    // 安全切换到指定分支（自动处理未解决合并/索引冲突，并在必要时从远程创建分支）
    async function safeCheckoutBranch(project, branchName) {
        console.log(chalk.cyan(`📥 [${project.name}] 尝试切换到分支 ${branchName}...`));

        let checkoutResult = await project.builder.runCommand(`git checkout ${branchName}`);
        if (checkoutResult.success) {
            console.log(chalk.green(`✓ [${project.name}] 已切换到分支 ${branchName}`));
            return;
        }

        const errorMsg = checkoutResult.error || '';

        // 情况 1：存在未解决的合并/索引冲突，或者当前分支有本地改动会被覆盖
        //         这两种情况都自动强制清理后重试，避免流程中断
        const needClean =
            /you need to resolve your current index first/i.test(errorMsg) ||
            /You have unmerged paths/i.test(errorMsg) ||
            /merge is in progress/i.test(errorMsg) ||
            /rebase in progress/i.test(errorMsg) ||
            /Your local changes to the following files would be overwritten by checkout/i.test(errorMsg) ||
            /Please commit your changes or stash them before you switch branches/i.test(errorMsg);

        if (needClean) {
            console.log(chalk.yellow(`⚠ [${project.name}] 检测到未解决的合并/索引冲突，自动清理工作区后重试切换分支 ${branchName}...`));

            // 这两个仓库专门用于打包，允许自动强制清理本地改动
            await project.builder.runCommand('git merge --abort');
            await project.builder.runCommand('git rebase --abort');
            await project.builder.runCommand('git reset --hard');
            await project.builder.runCommand('git clean -fd');

            console.log(chalk.cyan(`📥 [${project.name}] 清理完成，重试切换分支 ${branchName}...`));
            const retryResult = await project.builder.runCommand(`git checkout ${branchName}`);
            if (retryResult.success) {
                console.log(chalk.green(`✓ [${project.name}] 清理后已切换到分支 ${branchName}`));
                return;
            }

            throw new Error(`切换分支失败: ${retryResult.error || errorMsg}`);
        }

        // 情况 2：本地不存在该分支，尝试从远程 origin 创建
        const notFound =
            /did not match any file\(s\) known to git/i.test(errorMsg) ||
            /unknown revision or path not in the working tree/i.test(errorMsg);

        if (notFound) {
            console.log(chalk.yellow(`⚠ [${project.name}] 本地不存在分支 ${branchName}，尝试从远程 origin/${branchName} 创建...`));
            const createResult = await project.builder.runCommand(`git checkout -b ${branchName} origin/${branchName}`);
            if (!createResult.success) {
                throw new Error(`切换分支失败: ${createResult.error || errorMsg}`);
            }
            console.log(chalk.green(`✓ [${project.name}] 已从远程创建并切换到分支 ${branchName}`));
            return;
        }

        // 其它错误，直接抛出
        throw new Error(`切换分支失败: ${errorMsg}`);
    }

    // APK 构建面板消息（每个 chatId + projectName 一条）
    const apkPanelMessages = new Map(); // key: `${chatId}_${projectName}` -> messageId

    function getApkPanelKey(chatId, projectName) {
        return `${String(chatId)}_${projectName}`;
    }

    function buildApkPanelText(projectName, chatId) {
        const lines = [];

        // 计算当前项目在该群里的构建中 / 排队中列表
        const building = [];
        if (
            isApkBuilding &&
            currentApkBuildProjectName === projectName &&
            currentApkBuildChatId &&
            String(currentApkBuildChatId) === String(chatId)
        ) {
            building.push(currentApkBuildBranch);
        }

        const queued = apkBuildQueue
            .filter(task =>
                task.projectName === projectName &&
                String(task.chatId) === String(chatId)
            )
            .map(task => task.displayBranch || task.branchName);

        const total = building.length + queued.length;
        const queuedCount = queued.length;

        lines.push(`🛠 ${projectName} APK 构建面板`, '');

        lines.push('🚧 构建中');
        if (building.length > 0) {
            for (const name of building) {
                lines.push(`• ${name}`);
            }
        } else {
            lines.push('• （空）');
        }
        lines.push('');

        lines.push(`⏳ 排队中（${queuedCount}）`);
        if (queuedCount > 0) {
            for (const name of queued) {
                lines.push(`• ${name}`);
            }
        } else {
            lines.push('• （空）');
        }
        lines.push('');

        lines.push(`📊 当前任务总数：${total}`);

        return lines.join('\n');
    }

    async function updateApkPanel(chatId, projectName) {
        if (!projectName) return;
        const key = getApkPanelKey(chatId, projectName);
        const messageId = apkPanelMessages.get(key) || null;
        const text = buildApkPanelText(projectName, chatId);

        try {
            // 1. 如果有旧面板，先尝试删除（忽略失败）
            if (messageId) {
                try {
                    await client.deleteMessages(chatId, [messageId], { revoke: true });
                } catch (e) {
                    console.log(chalk.yellow('删除旧 APK 构建面板失败（可忽略）:', e.message));
                }
            }

            // 2. 发送新的面板消息并记录 messageId
            const msg = await client.sendMessage(chatId, { message: text });
            apkPanelMessages.set(key, msg.id);
        } catch (e) {
            console.log(chalk.yellow('更新 APK 构建面板失败:', e.message));
        }
    }

    // 将 APK 打包任务加入队列，按顺序执行（按钮、文本命令、压缩包自动触发共用）
    async function enqueueApkBuild(branchName, chatId) {
        // 先解析项目和实际分支名，用于后续统一去重与展示
        let displayProject = '未知项目';
        let displayBranch = branchName;
        let resolvedActualBranch = branchName;
        let project = null;

        try {
            const resolved = await resolveProjectAndBranch(branchName);
            if (!resolved) {
                await client.sendMessage(chatId, {
                    message: `❌ 打包失败：WG-WEB 和 WGAME-WEB 中都未找到分支 ${branchName}，请确认远端是否存在`,
                });
                return;
            }
            project = resolved.project;
            displayProject = project && project.name ? project.name : displayProject;
            displayBranch = resolved.actualBranchName || branchName;
            resolvedActualBranch = resolved.actualBranchName || branchName;
        } catch (error) {
            console.log(chalk.red('验证分支失败(队列加入时):'), error.message);
            try {
                await client.sendMessage(chatId, {
                    message: `❌ 打包失败：WG-WEB 和 WGAME-WEB 中都未找到分支 ${branchName}，请确认远端是否存在`,
                });
            } catch (e) {
                console.log(chalk.yellow('发送打包失败提示失败:', e.message));
            }
            return;
        }

        // 使用实际分支名进行去重判断
        // 如果当前正在打包同一项目同一分支，直接提示并返回
        if (
            isApkBuilding &&
            currentApkBuildProjectName === displayProject &&
            currentApkBuildBranch === resolvedActualBranch &&
            currentApkBuildChatId &&
            String(currentApkBuildChatId) === String(chatId)
        ) {
            try {
                await client.sendMessage(chatId, {
                    message:
                        `⚠️ APK 正在打包中，无需重复打包\n\n` +
                        `📦 项目：${displayProject}\n` +
                        `🌿 分支：${displayBranch}`,
                });
            } catch (e) {
                console.log(chalk.yellow('发送“分支已在打包中”提示失败:', e.message));
            }
            return;
        }

        // 检查是否已在 APK 队列中（同一 chatId + 项目 + 分支）
        const existingIndex = apkBuildQueue.findIndex(task =>
            task.projectName === displayProject &&
            task.branchName === resolvedActualBranch &&
            String(task.chatId) === String(chatId)
        );
        if (existingIndex !== -1) {
            try {
                await client.sendMessage(chatId, {
                    message:
                        `⚠️ 分支已在队列中\n\n` +
                        `📦 项目：${displayProject}\n` +
                        `🌿 分支：${displayBranch}`,
                });
            } catch (e) {
                console.log(chalk.yellow('发送“分支已在队列中”提示失败:', e.message));
            }
            // 同样更新一次面板，确保面板内容最新
            await updateApkPanel(chatId, displayProject);
            return;
        }

        // 入队（使用解析后的实际分支名 + 项目信息）
        apkBuildQueue.push({
            branchName: resolvedActualBranch,
            displayBranch,
            chatId,
            projectName: displayProject,
        });

        console.log(chalk.cyan(`📋 APK 打包加入队列: [${displayProject}] ${displayBranch}`));

        // 更新面板
        await updateApkPanel(chatId, displayProject);

        if (!isApkBuilding) {
            processNextApkInQueue();
        }
    }

    async function processNextApkInQueue() {
        if (apkBuildQueue.length === 0) {
            return;
        }
        const task = apkBuildQueue.shift();
        isApkBuilding = true;
        currentApkBuildBranch = task.branchName;
        currentApkBuildProjectName = task.projectName || '未知项目';
        currentApkBuildChatId = task.chatId;

        console.log(chalk.cyan(`\n📋 处理 APK 队列任务: [${currentApkBuildProjectName}] ${task.branchName} (剩余 ${apkBuildQueue.length} 个)`));

        // 刚开始处理时刷新一次面板
        await updateApkPanel(task.chatId, currentApkBuildProjectName);

        try {
            await triggerApkBuildForBranch(task.branchName, task.chatId, null);
        } catch (error) {
            console.error(chalk.red('APK 队列任务失败:'), error);
        } finally {
            isApkBuilding = false;
            currentApkBuildBranch = '';
            currentApkBuildProjectName = '';
            currentApkBuildChatId = null;

            // 任务完成后再次刷新面板
            await updateApkPanel(task.chatId, task.projectName || '未知项目');

            setTimeout(() => processNextApkInQueue(), 2000);
        }
    }

    // 统一触发 APK 打包的入口（由队列处理器调用，或单次直接调用）
    async function triggerApkBuildForBranch(branchName, chatId, existingStatusMsgId) {
        // 先在 WG-WEB / WGAME-WEB 中解析出实际项目和分支名
        let resolved;
        try {
            resolved = await resolveProjectAndBranch(branchName);
        } catch (error) {
            console.log(chalk.red('验证分支失败:'), error.message);
        }

        if (!resolved) {
            await client.sendMessage(chatId, {
                message: `❌ 打包失败：WG-WEB 和 WGAME-WEB 中都未找到分支 ${branchName}，请确认远端是否存在`,
            });
            return;
        }

        const { project, actualBranchName } = resolved;
        console.log(chalk.cyan(`将在项目 ${project.name} 中打包分支: ${actualBranchName}`));

        // 不再单独发送“构建任务已创建”消息，由 APK 构建面板统一展示队列与进度
        const statusMsgId = null;

        // 这里不再预先读取配置，所有与 appDownPath / proxyShareUrlList 相关的信息
        // 都在 handleBuildApkForBranch 中，在切换到目标分支之后统一读取，避免串分支。
        const options = {
            packageId: null,
            appName: null,
            appNameSlug: null,
            primaryDomain: null,
            statusMsgId,
        };

        await handleBuildApkForBranch(project, actualBranchName, chatId, options);
    }

    // 调用外部打包接口，触发 APK 构建
    async function callPackApi(appNameSlug, webUrl, imageUrl) {
        const slugForPack = (appNameSlug || '').toLowerCase();

        const payload = [
            {
                app_name: slugForPack || appNameSlug,
                web_url: webUrl,
                image_url: imageUrl,
            },
        ];

        console.log(chalk.cyan(`📦 调用打包接口: app_name=${slugForPack || appNameSlug}, web_url=${webUrl}, image_url=${imageUrl}`));

        const maxAttempts = 3;
        const retryDelayMs = 5000;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await axios.post('http://47.128.239.172:8000/pack', payload, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 60000, // 适当放宽一点等待时间
                });

                console.log(chalk.green('✅ 打包接口触发成功'));
                return;
            } catch (error) {
                console.log(chalk.yellow(`⚠ 调用打包接口失败（第 ${attempt}/${maxAttempts} 次）：${error.message}`));
                if (attempt === maxAttempts) {
                    // 如果是 socket hang up / 连接被重置，视为触发成功但对方主动断开，继续后续轮询流程
                    const msg = (error && error.message) || '';
                    if (error && (error.code === 'ECONNRESET' || /socket hang up/i.test(msg))) {
                        console.log(chalk.yellow('⚠ 打包接口连接被对方关闭（socket hang up），将继续轮询 /list 检查打包结果'));
                        return;
                    }
                    throw error;
                }
                await new Promise(r => setTimeout(r, retryDelayMs));
            }
        }
    }

    // 带重试的文件下载（用于从打包服务器下载 APK）
    async function downloadFileWithRetry(url, localPath, maxAttempts = 12, timeoutMs = 15000) {
        const retryDelayMs = 5000;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            console.log(chalk.cyan(`📥 第 ${attempt}/${maxAttempts} 次尝试下载 APK: ${url}`));

            try {
                // 每次下载尝试设置 15 秒超时，超时会主动中止请求并记为一次失败
                const response = await axios.get(url, { responseType: 'stream', timeout: timeoutMs });

                await new Promise((resolve, reject) => {
                    const writer = fs.createWriteStream(localPath);
                    response.data.pipe(writer);
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });

                console.log(chalk.green(`📦 APK 下载完成: ${localPath}`));
                return;
            } catch (error) {
                const msg = (error && error.message) || '';
                const code = error && error.code;

                console.log(chalk.yellow(`⚠ 下载 APK 失败（第 ${attempt}/${maxAttempts} 次）：${msg}`));

                const isRetryable =
                    code === 'ECONNRESET' ||
                    code === 'ETIMEDOUT' ||
                    /socket hang up/i.test(msg) ||
                    /timeout/i.test(msg);

                if (!isRetryable || attempt === maxAttempts) {
                    throw error;
                }

                await new Promise(r => setTimeout(r, retryDelayMs));
            }
        }
    }

    // 轮询外部接口，等待对应 APK 打包完成
    async function waitForPackedApk(appNameSlug, triggerTimeMs, maxAttempts = 10, intervalMs = 60000, chatId, statusMsgId, branchName) {
        const slugForPack = (appNameSlug || '').toLowerCase();
        const targetName = `app-${slugForPack}.apk`;
        const unsignedPattern = new RegExp(`^unsigned_${slugForPack}_.+_modified\\.apk$`, 'i');

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            console.log(chalk.cyan(`🔍 第 ${attempt}/${maxAttempts} 次检查打包结果...`));

            // 尝试在群组状态消息中同步进度（不影响主流程）
            if (chatId && statusMsgId) {
                const progressText =
                    `🚀 正在打包 APK\n\n` +
                    (branchName ? `🌿 分支: ${branchName}\n` : '') +
                    `📱 目标 APK: app-${slugForPack}.apk\n` +
                    `⏱ 第 ${attempt}/${maxAttempts} 次检查打包结果...`;
                try {
                    await client.editMessage(chatId, {
                        id: statusMsgId,
                        message: progressText,
                    });
                } catch (e) {
                    console.log(chalk.gray(`更新状态消息失败（可忽略）: ${e.message}`));
                }
            }

            let files = [];
            // 访问 /list：如果网络请求失败则在当前 attempt 内一直重试，直到成功为止
            // 只有成功拿到列表并检查完结果后，才算“完成一次检查”（共 maxAttempts 次）
            // 这样可以保证“总共 10 次有效检查”，而网络层错误会自动保底重试
            while (true) {
                try {
                    const res = await axios.get('http://47.128.239.172:8000/list', { timeout: 10000 });
                    files = res.data && Array.isArray(res.data.files) ? res.data.files : [];
                    break;
                } catch (error) {
                    const msg = (error && error.message) || '';
                    console.log(chalk.yellow(`⚠ 访问 /list 失败（第 ${attempt}/${maxAttempts} 次）：${msg}，将继续重试...`));
                    // 保持在当前 attempt，不增加次数，只是等待一段时间后再试一次
                    await new Promise(r => setTimeout(r, intervalMs));
                    continue;
                }
            }

            // 优先匹配正式签名的 app-{slug}.apk，且 modified 时间不早于本次打包触发时间
            let match = files.find(f => f && f.name === targetName);

            // 如果没有正式版本，则尝试匹配 unsigned_{slug}_*.apk
            if (!match) {
                match = files.find(f =>
                    f &&
                    typeof f.name === 'string' &&
                    unsignedPattern.test(f.name)
                );
            }

            if (match && match.modified) {
                // modified 是格林尼治时间字符串，例如 "2026-02-25 08:58:27"
                // 将其转换为 UTC 毫秒进行比较，只接受触发时间之后生成的包
                const modifiedStr = String(match.modified).replace(' ', 'T') + 'Z';
                const modifiedMs = Date.parse(modifiedStr);

                if (!isNaN(modifiedMs) && modifiedMs >= triggerTimeMs) {
                    console.log(chalk.green(`✅ 找到本次打包生成的 APK: ${match.name} (modified=${match.modified})`));
                    return match; // { url, name, modified, size }
                }

                console.log(chalk.gray(`略过旧 APK: ${match.name} (modified=${match.modified})`));
            }

            await new Promise(r => setTimeout(r, intervalMs));
        }

        throw new Error(`在 ${maxAttempts} 次轮询内未找到已打包 APK（app-${slugForPack}.apk 或 unsigned_${slugForPack}_*_modified.apk）`);
    }

    // 处理按钮 / 文本命令触发的 APK 打包 + 上传到 S3
    async function handleBuildApkForBranch(project, branchName, chatId, { packageId, appName, appNameSlug, primaryDomain, statusMsgId }) {
        console.log(chalk.cyan(`\n🚀 开始为项目 ${project.name} 的分支 ${branchName} 打包 APK`));

        // 全流程中需要多处使用的 Logo 上传结果
        let logoInfo = null;

        // 1. 记录当前分支
        const currentBranch = await project.builder.runCommand('git rev-parse --abbrev-ref HEAD');
        let originalBranch = currentBranch.success ? currentBranch.output.trim() : null;

        try {
            // 2. 切换到目标分支并更新代码（与检测逻辑保持一致）
            if (originalBranch !== branchName) {
                if (config.build.autoFetchPull) {
                    console.log(chalk.cyan('📥 获取远程分支信息...'));
                    const fetchResult = await project.builder.runCommand('git fetch --all');
                    if (!fetchResult.success) {
                        console.log(chalk.yellow(`⚠ Fetch 失败，继续尝试切换分支: ${fetchResult.error}`));
                    } else {
                        console.log(chalk.green('✓ Fetch 完成'));
                    }
                }

                // 使用安全切换逻辑（自动清理未解决冲突 & 远程创建）
                await safeCheckoutBranch(project, branchName);
            } else {
                console.log(chalk.gray(`当前已在分支 ${branchName}`));
            }

            if (config.build.autoFetchPull) {
                console.log(chalk.cyan('📥 拉取分支最新代码...'));
                const pullResult = await project.builder.runCommand('git pull');
                if (!pullResult.success) {
                    console.log(chalk.yellow(`⚠ Pull 失败，使用本地代码: ${pullResult.error}`));
                } else {
                    console.log(chalk.green('✓ 代码已更新到最新'));
                }
            }

            // 从当前分支最新配置中解析 appDownPath / proxyShareUrlList，确保不会串分支
            try {
                console.log(chalk.cyan('📖 从当前分支配置解析 appDownPath / proxyShareUrlList...'));
                const cfg = await readPackageIdFromBranch(project.path, branchName);
                if (cfg && cfg.success) {
                    appName = cfg.appName || `app-${branchName}.apk`;

                    appNameSlug = cfg.appNameSlug;
                    if (!appNameSlug && appName && typeof appName === 'string') {
                        const fileName = appName.split('/').pop() || appName;
                        const m = fileName.match(/^app-(.+)\.apk$/i);
                        if (m && m[1]) {
                            appNameSlug = m[1];
                        }
                    }
                    if (!appNameSlug) {
                        appNameSlug = branchName;
                    }

                    primaryDomain = cfg.primaryDomain;
                    packageId = cfg.packageId || packageId;
                } else {
                    console.log(chalk.yellow('当前分支配置中未找到 packageId / appDownPath，使用默认值'));
                    appName = appName || `app-${branchName}.apk`;
                    appNameSlug = appNameSlug || branchName;
                }
            } catch (e) {
                console.log(chalk.yellow(`解析当前分支配置失败，将使用默认参数: ${e.message}`));
                appName = appName || `app-${branchName}.apk`;
                appNameSlug = appNameSlug || branchName;
            }

            // 3. 上传 logo（gulu_top.avif -> png）到 S3（实际转换为 PNG 再上传）
            try {
                const logoRelativePath = path.join('home', 'img', 'configFile', 'gulu_top.avif');
                const logoPath = path.join(project.path, logoRelativePath);

                if (!fs.existsSync(logoPath)) {
                    console.log(chalk.yellow(`⚠ 未找到 logo 文件: ${logoPath}`));
                } else {
                    const tempDir = path.join(__dirname, 'tmp');
                    if (!fs.existsSync(tempDir)) {
                        fs.mkdirSync(tempDir, { recursive: true });
                    }

                    // 使用当前分支名或 appNameSlug 作为图片名，避免串分支
                    const slug = appNameSlug || branchName;
                    const pngName = `${slug}.png`; // 例如 wg-burgguer.png
                    const pngPath = path.join(tempDir, pngName);

                    console.log(chalk.cyan(`🖼 正在将 gulu_top.avif 转为 PNG（命名为 ${pngName}）...`));
                    await sharp(logoPath).png().toFile(pngPath);
                    console.log(chalk.green(`🖼 PNG Logo 生成完成: ${pngPath}`));

                    // 构造 S3 Key：与 APK 一样放在桶根目录
                    // APK: app-wg-burgguer.apk
                    // Logo: wg-burgguer.png
                    const logoKey = pngName;
                    try {
                        logoInfo = await uploadFileToS3(pngPath, logoKey, 'image/png');
                        console.log(chalk.green('📤 Logo 已上传到 S3'));
                    } catch (e) {
                        console.log(chalk.yellow('上传 Logo 到 S3 失败:', e.message));
                    } finally {
                        if (fs.existsSync(pngPath)) {
                            fs.unlinkSync(pngPath);
                            console.log(chalk.gray('🧹 已删除临时 PNG Logo 文件'));
                        }
                    }

                    // 不再单独发 Logo 消息，与最终 APK 结果合并为一条
                }
            } catch (e) {
                console.log(chalk.yellow('处理 Logo 时发生错误:', e.message));
            }

            // 4. 调用外部接口打包 APK
            if (!appNameSlug) {
                throw new Error('未能从配置中解析出 app_name（appDownPath 中 app- 和 .apk 之间的部分）');
            }

            if (!primaryDomain) {
                throw new Error('未能从配置中解析出 proxyShareUrlList[0] 域名，无法生成 web_url');
            }

            // 生成 web_url，例如 https://aniverssriopg.com/?isapk=1
            const webUrlDomain = primaryDomain.replace(/\/+$/, '');
            const webUrl = `${webUrlDomain}?isapk=1`;

            // 如果 Logo 上传最终失败，不再终止整个 APK 流程，而是继续使用空 image_url 调用打包接口
            let imageUrl = (logoInfo && logoInfo.url) ? logoInfo.url : '';
            if (!imageUrl) {
                console.log(chalk.yellow(`⚠ Logo 未成功上传到 S3（分支: ${branchName}），将使用空 image_url 调用打包接口`));
            }

            // 记录打包触发时间（UTC 毫秒），用于过滤旧包
            const triggerTimeMs = Date.now();

            await callPackApi(appNameSlug, webUrl, imageUrl);

            // 5. 轮询等待打包完成（最多 10 次，每次间隔 30 秒）
            const packed = await waitForPackedApk(appNameSlug, triggerTimeMs, 10, 30000, chatId, statusMsgId, branchName);

            // 6. 下载打包完成的 APK 到本地
            const tempDir = path.join(__dirname, 'tmp');
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            const apkFileNameFromServer = packed.name; // 例如 app-terrawin66.apk
            const localApkPath = path.join(tempDir, apkFileNameFromServer);

            const downloadUrl = `http://47.128.239.172:8000${packed.url}`;
            console.log(chalk.cyan(`📥 开始下载打包好的 APK: ${downloadUrl}`));

            // 下载 APK：最多 12 次重试，每次下载单次最长 15 秒
            await downloadFileWithRetry(downloadUrl, localApkPath, 12, 15000);

            // 7. 上传 APK 到 S3（不上传到 Telegram）
            // 为了与 appDownPath 完全一致，这里优先使用当前分支配置中的 appName 作为 S3 Key
            // 例如 appDownPath: https://gulu3.s3.sa-east-1.amazonaws.com/app-Terrawin66.apk
            // 则 S3 Key == app-Terrawin66.apk
            const s3Key = appName || apkFileNameFromServer;

            const { key, url } = await uploadFileToS3(localApkPath, s3Key, 'application/vnd.android.package-archive');

            // 8. 第二条消息：APK 结果 + Logo 信息（Logo 放在 APK 信息上方）
            const finalApkNameForLog = appName || apkFileNameFromServer;
            let msg =
                `✅ APK 打包并上传完成\n\n` +
                `🌿 分支: ${branchName}\n` +
                (primaryDomain ? `🌐 主域名: ${primaryDomain}\n` : '');

            if (logoInfo && logoInfo.url) {
                msg +=
                    `🎨 Logo 已上传到 S3\n` +
                    `🔗 地址: ${logoInfo.url}\n`;
            }

            msg +=
                (packageId ? `🆔 Package ID: ${packageId}\n` : '') +
                `📱 APK 文件名: ${finalApkNameForLog}\n` +
                `🗂 S3 路径: ${key}\n` +
                `🔗 下载地址: ${url}`;

            try {
                await client.sendMessage(chatId, { message: msg });
            } catch (e) {
                console.log(chalk.yellow('发送 APK 结果消息失败:', e.message));
            }
        } catch (error) {
            // 统一处理 APK 打包流程中的异常，并在群里提示失败原因
            console.error(chalk.red(`打包 APK 失败: [${project.name}] ${branchName}`), error);

            const safeProjectName = project && project.name ? project.name : '未知项目';
            const errorMsg = (error && error.message) || String(error);

            const failMsg =
                `❌ APK 打包失败\n\n` +
                `📁 项目: ${safeProjectName}\n` +
                `🌿 分支: ${branchName}\n` +
                `📝 错误信息: ${errorMsg}`;

            try {
                await client.sendMessage(chatId, { message: failMsg });
            } catch (e) {
                console.log(chalk.yellow('发送 APK 失败结果消息失败:', e.message));
            }

            // 继续抛出，方便上层逻辑知晓失败（但不再额外发送提示）
            throw error;
        } finally {
            // 清理本地 APK 临时文件
            try {
                const tempDir = path.join(__dirname, 'tmp');
                const files = fs.existsSync(tempDir) ? fs.readdirSync(tempDir) : [];
                for (const f of files) {
                    const p = path.join(tempDir, f);
                    try {
                        fs.unlinkSync(p);
                    } catch {
                        // 忽略
                    }
                }
                console.log(chalk.gray('🧹 已清理 tmp 目录下的临时文件'));
            } catch (e) {
                console.log(chalk.yellow('清理临时文件失败:', e.message));
            }

            // 此处不再恢复原始分支，保持当前分支为最近一次操作的分支
        }
    }

    // 执行构建流程（可复用函数，使用指定 project 的 builder）
    async function executeBuild(project, branchName, senderId, chatId) {
        shouldCancelBuild = false;
        const buildRunner = project && project.builder ? project.builder : builder;

        const log = (...args) => console.log(chalk.blue(`[${branchName}]`), ...args);

        const updateProgress = async (stage, percent, msg) => {
            if (shouldCancelBuild) return;
            const text = msg || stage || '';
            if (percent === 100 || percent % 20 === 0) {
                log(`${percent}%`, text);
            }
        };

        const result = await buildRunner.fullBuild(branchName, updateProgress);

        if (shouldCancelBuild) {
            log(chalk.yellow('任务已中断'));
            if (result && result.zipFilePath && fs.existsSync(result.zipFilePath)) {
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

        // 上传 ZIP 到 Telegram，增加简单重试以应对短暂断线（Not connected / connection closed 等）
        let uploadSuccess = false;
        const maxUploadAttempts = 3;
        const uploadDelayMs = 3000;

        for (let attempt = 1; attempt <= maxUploadAttempts; attempt++) {
            try {
                log(chalk.cyan(`开始上传构建产物到 Telegram（尝试 ${attempt}/${maxUploadAttempts}）`));
                await client.sendFile(chatId, {
                    file: result.zipFilePath,
                    forceDocument: true,
                });
                log(chalk.green('上传完成'));
                uploadSuccess = true;
                break;
            } catch (error) {
                const msg = (error && error.message) || '';
                log(chalk.red(`上传失败（第 ${attempt}/${maxUploadAttempts} 次）：${msg}`));

                const retryable =
                    /Not connected/i.test(msg) ||
                    /connection closed/i.test(msg) ||
                    /ETIMEDOUT/i.test(msg);

                if (!retryable || attempt === maxUploadAttempts) {
                    break;
                }

                log(chalk.yellow(`⏳ ${uploadDelayMs / 1000} 秒后重试上传到 Telegram...`));
                await new Promise(resolve => setTimeout(resolve, uploadDelayMs));
            }
        }

        if (!uploadSuccess) {
            log(chalk.red('上传多次失败，放弃发送构建产物到 Telegram'));
        }

        // 构建完成后，模拟“上传压缩包”触发后续检测流程
        try {
            if (project && chatId && result && (result.zipFileName || result.zipFilePath)) {
                const fileName =
                    result.zipFileName ||
                    (result.zipFilePath ? path.basename(result.zipFilePath) : `${branchName}.zip`);

                const fileTask = {
                    fileName,
                    branchName,
                    actualBranchName: branchName,
                    project,
                    chatId,
                    timestamp: new Date(),
                };

                if (isProcessingFile || isBuilding) {
                    fileProcessQueue.push(fileTask);
                    log(chalk.gray(`📦 自动构建文件加入检测队列: ${fileName} (位置 ${fileProcessQueue.length})`));
                } else {
                    log(chalk.cyan(`📦 自动构建文件触发检测: ${fileName}`));
                    (async () => {
                        await processFileTask(fileTask);
                    })();
                }
            } else {
                log(chalk.gray('跳过自动压缩包检测：缺少 project/chatId 或 zip 信息'));
            }
        } catch (e) {
            log(chalk.yellow('自动触发压缩包检测失败（可忽略）:'), e.message);
        } finally {
            if (result && result.zipFilePath && fs.existsSync(result.zipFilePath)) {
                fs.unlinkSync(result.zipFilePath);
                log('已清理临时文件');
            }
        }

        return { cancelled: false };
    }

    // 处理队列中的下一个任务
    async function processNextInQueue() {
        if (buildQueue.length === 0) {
            // 👉 如果没有待构建任务了，但有待检测的文件，并且当前没在处理文件，
            //    这里可以顺带启动一下文件检测队列
            if (!isProcessingFile && fileProcessQueue.length > 0) {
                const nextFileTask = fileProcessQueue.shift();
                console.log(
                    chalk.cyan(`\n📦 处理队列中的文件: ${nextFileTask.fileName} (剩余 ${fileProcessQueue.length}个)`)
                );
                setTimeout(() => {
                    processFileTask(nextFileTask);
                }, 1000);
            }
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
            await executeBuild(nextTask.project, nextTask.branchName, nextTask.userId, nextTask.chatId);
        } catch (error) {
            console.error(chalk.red('队列任务处理失败:'), error);
        }

        // 重置状态
        isBuilding = false;
        currentBuildBranch = '';
        currentBuildId = null;

        // 👉 构建刚结束时，如果有待检测文件且当前没在处理文件，也可以启动文件队列
        if (!isProcessingFile && fileProcessQueue.length > 0) {
            const nextFileTask = fileProcessQueue.shift();
            console.log(
                chalk.cyan(`\n📦 处理队列中的文件: ${nextFileTask.fileName} (剩余 ${fileProcessQueue.length}个)`)
            );
            setTimeout(() => {
                processFileTask(nextFileTask);
            }, 1000);
        }

        // 继续处理下一个构建任务
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

