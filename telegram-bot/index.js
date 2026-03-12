const TelegramBot = require('node-telegram-bot-api');
const chalk = require('chalk');
const { SocksProxyAgent } = require('socks-proxy-agent');
const config = require('./config');
const apkTracker = require('./apk-tracker');
const { extractBranchNameFromFileName } = require('./config-reader');

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

// 记录「是否打包 APK」交互的超时定时器：messageId -> { chatId, branch, timer }
const pendingDecisions = new Map();
const APK_DECISION_TIMEOUT_MS = 30000;

console.log(chalk.green('✓ Telegram Bot 已启动（APK 选择监听模式）'));
console.log(chalk.gray('等待群组消息...\n'));

// 监听：群消息 + 压缩包 + APK 成功通知
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

    // 1) 打印基础信息（仅目标群）
    console.log(chalk.gray('收到群组消息 (Bot 监听中):'));
    console.log(chalk.gray('  群组ID  :'), chatId);
    if (chatTitle) {
        console.log(chalk.gray('  群组名  :'), chatTitle);
    }
    console.log(chalk.gray('  用户ID  :'), userId);
    console.log(chalk.gray('  用户名  :'), username);
    console.log(chalk.gray('  文本内容:'), text);

    // 2) 监听压缩包 -> 弹出「是否打包 APK」按钮，并按规则收录
    if (msg.document && msg.document.file_name) {
        const fileName = msg.document.file_name;
        const branchFromFile = extractBranchNameFromFileName(fileName);

        if (branchFromFile) {
            console.log(chalk.cyan('已收到压缩包，对应分支:'), branchFromFile, '文件名:', fileName);

            bot
                .sendMessage(
                    chatId,
                    `已收到压缩包，对应分支为: ${branchFromFile}\n\n是否立即打包 APK？`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: '✅ 立即打包 APK',
                                        callback_data: `apk_yes|${branchFromFile}`,
                                    },
                                    {
                                        text: '⏱ 暂不打包（30 秒后自动收录）',
                                        callback_data: `apk_no|${branchFromFile}`,
                                    },
                                ],
                            ],
                        },
                    },
                )
                .then((sent) => {
                    const key = sent.message_id;
                    if (pendingDecisions.has(key)) {
                        clearTimeout(pendingDecisions.get(key).timer);
                    }

                    const timer = setTimeout(() => {
                        const record = pendingDecisions.get(key);
                        if (!record) return;
                        pendingDecisions.delete(key);

                        apkTracker.addOrUpdate(branchFromFile, {
                            source: 'timeout_auto',
                            fileName,
                            chatId,
                            messageId: msg.message_id,
                        });

                        console.log(
                            chalk.yellow(
                                '30 秒内未选择，已自动收录到等待打包 APK 列表:',
                            ),
                            branchFromFile,
                        );

                        // 超时后更新提示并移除按钮
                        bot
                            .editMessageText(
                                `已收到压缩包，对应分支为: ${branchFromFile}\n\n已超时，默认加入等待打包 APK 列表。`,
                                {
                                    chat_id: chatId,
                                    message_id: key,
                                },
                            )
                            .catch(() => { });
                    }, APK_DECISION_TIMEOUT_MS);

                    pendingDecisions.set(key, {
                        chatId,
                        branch: branchFromFile,
                        timer,
                    });
                })
                .catch(() => { });
        }
    }

    // 3) 自动：监听“APK 打包成功”通知 -> 从等待列表中移除
    if (text && text.startsWith('✅ APK 打包并上传完成')) {
        const match = text.match(/🌿 分支:\s*([^\s]+)/);
        if (match && match[1]) {
            const doneBranch = match[1].trim();
            apkTracker.remove(doneBranch);
            console.log(chalk.green('已从等待打包 APK 列表移除分支:'), doneBranch);
        }
    }

    // 4) 文本命令：/help + /apk_* 管理等待打包 APK 列表
    if (text) {
        const cleanCmd = text.split(/\s+/)[0].split('@')[0];

        // /help 指令：展示可用命令说明
        if (cleanCmd === '/help') {
            const helpMessage =
                '🤖 APK 打包助手 - 命令列表\n\n' +
                '\n启动后会自动记录未打包 APK 的分支，复刻凌晨最后一套结束时，需执行 /apk_start_all，即可一键触发所有待打包 APK 的构建流程。\n\n\n' +
                '/apk_list - 查看等待打包 APK 列表\n' +
                '/apk_add 分支1 分支2 ... - 手动添加等待打包 APK 分支\n' +
                '/apk_del 分支1 分支2 ... - 从列表中删除分支\n' +
                '/apk_start_all - 一键触发所有等待打包 APK 分支\n' +
                '/apk_clear - 清空等待打包 APK 列表\n\n';

            sendSafe(chatId, helpMessage);
            return;
        }

        // /apk_* 指令
        if (cleanCmd.startsWith('/apk')) {
            handleApkCommands(text, chatId, msg.message_id);
            return;
        }
    }

    console.log();
});

function sendSafe(chatId, message) {
    bot.sendMessage(chatId, message).catch(() => { });
}

function handleApkCommands(rawText, chatId, messageId) {
    const text = (rawText || '').trim();
    if (!text.startsWith('/apk')) return;

    const parts = text.split(/\s+/);
    if (parts.length === 0) return;

    const first = parts[0]; // 例如 /apk_list 或 /apk_list@kk_toolbox_bot
    const cmd = first.split('@')[0];
    const args = parts.slice(1);

    // /apk_list - 查看等待打包 APK 列表
    if (cmd === '/apk_list') {
        const all = apkTracker.getAll();
        if (all.length === 0) {
            sendSafe(chatId, '📭 当前没有等待打包 APK 的分支');
            // 删除用户输入的命令消息，避免聊天窗口遗留 /apk_list@bot 文本
            return bot.deleteMessage(chatId, messageId).catch(() => { });
        }
        const lines = all.map((item, idx) => {
            const src = item.source || 'auto';
            return `${idx + 1}. ${item.branch} (${src})`;
        });
        sendSafe(chatId, '📋 等待打包 APK 列表:\n\n' + lines.join('\n'));
        return bot.deleteMessage(chatId, messageId).catch(() => { });
    }

    // /apk_add 分支1 分支2 ...
    if (cmd === '/apk_add') {
        if (args.length === 0) {
            sendSafe(chatId, '❌ 用法: /apk_add 分支名1 分支名2 ...');
            return bot.deleteMessage(chatId, messageId).catch(() => { });
        }
        const added = [];
        for (const b of args) {
            const branch = (b || '').trim();
            if (!branch) continue;
            apkTracker.addOrUpdate(branch, { source: 'manual', chatId });
            added.push(branch);
        }
        if (added.length === 0) {
            sendSafe(chatId, '❌ 未解析到有效分支名');
            return bot.deleteMessage(chatId, messageId).catch(() => { });
        }
        sendSafe(chatId, `✅ 已添加/更新分支: ${added.join(', ')}`);
        return bot.deleteMessage(chatId, messageId).catch(() => { });
    }

    // /apk_del 分支1 分支2 ...
    if (cmd === '/apk_del') {
        if (args.length === 0) {
            sendSafe(chatId, '❌ 用法: /apk_del 分支名1 分支名2 ...');
            return bot.deleteMessage(chatId, messageId).catch(() => { });
        }
        const deleted = [];
        for (const b of args) {
            const branch = (b || '').trim();
            if (!branch) continue;
            apkTracker.remove(branch);
            deleted.push(branch);
        }
        if (deleted.length === 0) {
            sendSafe(chatId, '❌ 未解析到有效分支名');
            return bot.deleteMessage(chatId, messageId).catch(() => { });
        }
        sendSafe(chatId, `✅ 已删除分支: ${deleted.join(', ')}`);
        return bot.deleteMessage(chatId, messageId).catch(() => { });
    }

    // /apk_clear - 清空等待打包 APK 列表
    if (cmd === '/apk_clear') {
        apkTracker.clear();
        sendSafe(chatId, '🧹 已清空等待打包 APK 列表');
        return bot.deleteMessage(chatId, messageId).catch(() => { });
    }

    // /apk_start_all - 一键启动所有等待打包 APK 分支
    if (cmd === '/apk_start_all') {
        const all = apkTracker.getAll();
        if (all.length === 0) {
            sendSafe(chatId, '📭 当前没有等待打包 APK 的分支');
            return bot.deleteMessage(chatId, messageId).catch(() => { });
        }

        // 按分支去重，避免同一分支多次触发
        const uniqueBranches = Array.from(
            new Set(all.map((item) => (item.branch || '').trim()).filter(Boolean)),
        );

        if (uniqueBranches.length === 0) {
            return sendSafe(chatId, '📭 当前没有有效的分支记录');
        }

        // 依次触发用户机器人的打包 APK 流程
        for (const branch of uniqueBranches) {
            console.log(chalk.cyan('一键启动打包 APK，分支:'), branch);
            sendSafe(chatId, `打包APK ${branch}`);
        }

        sendSafe(
            chatId,
            `🚀 已为以下分支触发打包 APK:\n\n${uniqueBranches
                .map((b, i) => `${i + 1}. ${b}`)
                .join('\n')}`,
        );
        return bot.deleteMessage(chatId, messageId).catch(() => { });
    }
}

// 处理「是否打包 APK」按钮回调
bot.on('callback_query', (query) => {
    const data = query.data || '';
    if (!data.startsWith('apk_')) {
        return;
    }

    const message = query.message;
    if (!message) {
        return;
    }

    const chatId = message.chat.id;
    const messageId = message.message_id;

    const [action, branchRaw] = data.split('|');
    const branch = (branchRaw || '').trim();

    const record = pendingDecisions.get(messageId);

    // 先回复回调，避免 Telegram 持续 loading
    bot
        .answerCallbackQuery(query.id)
        .catch(() => { });

    if (!branch) {
        return;
    }

    if (action === 'apk_yes') {
        // 用户选择立即打包：清理超时定时器，不再走自动收录逻辑
        if (record && record.timer) {
            clearTimeout(record.timer);
        }
        pendingDecisions.delete(messageId);

        // 用户选择立即打包：记录到等待列表，并触发用户机器人的打包 APK 流程
        apkTracker.addOrUpdate(branch, {
            source: 'user_yes',
            chatId,
            messageId,
        });

        console.log(chalk.cyan('用户选择立即打包 APK，分支:'), branch);

        // 更新提示并移除按钮
        bot
            .editMessageText(
                `分支: ${branch}\n\n已选择立即打包 APK，正在触发打包流程...`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                },
            )
            .catch(() => { });

        // 通过在群里发送「打包APK 分支」来触发用户机器人
        sendSafe(chatId, `打包APK ${branch}`);
    } else if (action === 'apk_no') {
        // 用户选择暂不打包：清理定时器，本次完全不加入等待列表
        if (record && record.timer) {
            clearTimeout(record.timer);
        }
        pendingDecisions.delete(messageId);

        console.log(chalk.cyan('用户选择暂不打包 APK，本次不会加入等待列表，分支:'), branch);

        bot
            .editMessageText(
                `分支: ${branch}\n\n已选择暂不立即打包 APK，本次不会加入等待打包 APK 列表。`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                },
            )
            .catch(() => { });
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

