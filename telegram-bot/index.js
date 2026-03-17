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

// /apk_start_all 批次统计：收到所有分支的成功/失败后发汇总
let apkBatch = null; // { chatId, branches: string[], startTime, outcomes: Map<branch, 'success'|'failure'>, timeoutId }
const BATCH_SUMMARY_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 小时后发未完成汇总

// 从「APK 打包成功/失败」消息中提取分支名
function extractBranchFromApkMessage(text) {
    const t = text || '';

    // 新格式：✅ APK 打包完成 | 66BB2 | app-bet-66bb.apk
    let m = t.match(/^✅\s*APK\s*打包完成\s*\|\s*([^|]+)\|/m);
    if (m && m[1]) {
        return m[1].trim();
    }

    // 兼容旧格式：🌿 分支: xxx
    m = t.match(/🌿\s*分支:\s*([^\s\n]+)/);
    return m && m[1] ? m[1].trim() : null;
}

// 若当前批次已收齐所有结果，发送统计并清空批次
function trySendBatchSummary() {
    if (!apkBatch || apkBatch.outcomes.size < apkBatch.branches.length) return;
    const successList = [];
    const failureList = [];
    for (const b of apkBatch.branches) {
        const o = apkBatch.outcomes.get(b);
        if (o === 'success') successList.push(b);
        else if (o === 'failure') failureList.push(b);
    }
    const successCount = successList.length;
    const failureCount = failureList.length;
    let msg = `📊 APK 批量打包统计\n\n✅ 成功 ${successCount} 条`;
    if (successList.length) msg += '\n' + successList.map((b, i) => `${i + 1}. ${b}`).join('\n');
    msg += `\n\n❌ 失败 ${failureCount} 条`;
    if (failureList.length) msg += '\n' + failureList.map((b, i) => `${i + 1}. ${b}`).join('\n');
    sendSafe(apkBatch.chatId, msg);
    if (apkBatch.timeoutId) clearTimeout(apkBatch.timeoutId);
    apkBatch = null;
}

// 超时或部分完成时发送统计（未出结果的分支算「未完成」）
function sendBatchSummaryPartial() {
    if (!apkBatch) return;
    const successList = [];
    const failureList = [];
    const pendingList = [];
    for (const b of apkBatch.branches) {
        const o = apkBatch.outcomes.get(b);
        if (o === 'success') successList.push(b);
        else if (o === 'failure') failureList.push(b);
        else pendingList.push(b);
    }
    let msg = `📊 APK 批量打包统计（已超时/部分完成）\n\n✅ 成功 ${successList.length} 条`;
    if (successList.length) msg += '\n' + successList.map((b, i) => `${i + 1}. ${b}`).join('\n');
    msg += `\n\n❌ 失败 ${failureList.length} 条`;
    if (failureList.length) msg += '\n' + failureList.map((b, i) => `${i + 1}. ${b}`).join('\n');
    msg += `\n\n⏳ 未完成 ${pendingList.length} 条`;
    if (pendingList.length) msg += '\n' + pendingList.map((b, i) => `${i + 1}. ${b}`).join('\n');
    sendSafe(apkBatch.chatId, msg);
    if (apkBatch.timeoutId) clearTimeout(apkBatch.timeoutId);
    apkBatch = null;
}

// 是否启用压缩包交互（临时可关闭，默认开启；设置 ENABLE_ZIP_INTERACTIVE=0 可关闭）
const ENABLE_ZIP_INTERACTIVE = process.env.ENABLE_ZIP_INTERACTIVE !== '0';

console.log(chalk.green('✓ Telegram Bot 已启动（APK 选择监听模式）'));
console.log(chalk.gray('等待群组消息...\n'));

// 监听：群消息 + 压缩包 + APK 成功通知
bot.on('message', (msg) => {
    const chatId = msg.chat?.id;
    const chatTitle = msg.chat?.title || msg.chat?.username || '';
    const userId = msg.from?.id;
    const username = msg.from?.username || msg.from?.first_name || '';
    const text = msg.text ?? '';

    // 只处理：配置的目标群 或 私聊（私聊可执行 /apk_list、/apk_add、/apk_del）
    const isTargetGroup = config.chatId && chatId?.toString() === config.chatId.toString();
    const isPrivate = msg.chat?.type === 'private';
    if (!isTargetGroup && !isPrivate) {
        return;
    }

    // 1) 打印基础信息
    console.log(chalk.gray(isPrivate ? '收到私聊消息 (Bot 监听中):' : '收到群组消息 (Bot 监听中):'));
    console.log(chalk.gray('  群组ID  :'), chatId);
    if (chatTitle) {
        console.log(chalk.gray('  群组名  :'), chatTitle);
    }
    console.log(chalk.gray('  用户ID  :'), userId);
    console.log(chalk.gray('  用户名  :'), username);
    console.log(chalk.gray('  文本内容:'), text);

    // 2) 监听压缩包 -> 弹出「打包 APK」操作按钮，并按规则收录（可通过环境变量关闭）
    if (ENABLE_ZIP_INTERACTIVE && !isPrivate && msg.document && msg.document.file_name) {
        const fileName = msg.document.file_name;
        const branchFromFile = extractBranchNameFromFileName(fileName);

        if (branchFromFile) {
            console.log(chalk.cyan('已收到压缩包，对应分支:'), branchFromFile, '文件名:', fileName);

            bot.sendMessage(
                chatId,
                `📦 收到 APK 打包任务\n🌿 分支：${branchFromFile}\n⏱ 30秒未操作将自动加入队列`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '🚀 立即打包',
                                    callback_data: `apk_now|${branchFromFile}`,
                                },
                                {
                                    text: '❌ 取消任务',
                                    callback_data: `apk_cancel|${branchFromFile}`,
                                },
                            ],
                            [
                                {
                                    text: '📥 加入队列',
                                    callback_data: `apk_queue|${branchFromFile}`,
                                },
                            ],
                        ],
                    },
                }
            ).then((sent) => {
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
                            '30 秒内未选择，已自动收录到等待打包 APK 队列:',
                        ),
                        branchFromFile,
                    );

                    // 超时后更新提示并移除按钮
                    bot
                        .editMessageText(
                            `分支: ${branchFromFile}\n已加入「等待打包 APK」队列。`,
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

    // 3) 自动：监听“APK 打包成功”通知 -> 仅从等待列表中移除
    if (text && text.startsWith('✅ APK 打包')) { // 兼容「打包并上传完成」和「打包完成」两种前缀
        const doneBranch = extractBranchFromApkMessage(text);
        if (doneBranch) {
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
                '启动后会自动记录未打包 APK 的分支，复刻凌晨最后一套结束时，需执行 /apk_start_all，即可一键触发所有待打包 APK 的构建流程。\n\n' +
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
    bot.sendMessage(chatId, message, { disable_web_page_preview: true }).catch(() => { });
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

    // /apk_start_all - 一键启动所有等待打包 APK 分支（合并为一条命令）
    if (cmd === '/apk_start_all') {
        runApkStartAll(chatId);
        return bot.deleteMessage(chatId, messageId).catch(() => { });
    }
}

// 执行「一键触发所有等待打包 APK」：将所有分支合并成一条「打包APK xxx xxx」命令发送给用户机器人
function runApkStartAll(chatId) {
    const all = apkTracker.getAll();
    if (all.length === 0) {
        sendSafe(chatId, '📭 当前没有等待打包 APK 的分支');
        return;
    }

    const uniqueBranches = Array.from(
        new Set(all.map((item) => (item.branch || '').trim()).filter(Boolean)),
    );
    if (uniqueBranches.length === 0) {
        sendSafe(chatId, '📭 当前没有有效的分支记录');
        return;
    }

    const cmd = `打包APK ${uniqueBranches.join(' ')}`;
    console.log(chalk.cyan('一键启动打包 APK，命令:'), cmd);
    sendSafe(chatId, cmd);
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

    if (action === 'apk_now') {
        // 用户选择「立即打包」：清理超时定时器，不再走自动收录逻辑
        if (record && record.timer) {
            clearTimeout(record.timer);
        }
        pendingDecisions.delete(messageId);

        // 记录到等待列表，并触发用户机器人的打包 APK 流程
        apkTracker.addOrUpdate(branch, {
            source: 'user_now',
            chatId,
            messageId,
        });

        console.log(chalk.cyan('用户选择立即打包 APK，分支:'), branch);

        // 更新提示并移除按钮
        bot
            .editMessageText(
                `分支: ${branch}\n已选择立即打包 APK，正在触发打包流程...`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                },
            )
            .catch(() => { });

        // 通过在群里发送「打包APK 分支」来触发用户机器人
        sendSafe(chatId, `打包APK ${branch}`);
    } else if (action === 'apk_queue') {
        // 用户选择「加入队列」：清理定时器，只记录到等待列表，不立即触发打包
        if (record && record.timer) {
            clearTimeout(record.timer);
        }
        pendingDecisions.delete(messageId);

        apkTracker.addOrUpdate(branch, {
            source: 'queue_manual',
            chatId,
            messageId,
        });

        console.log(chalk.cyan('用户选择加入打包队列，分支:'), branch);

        bot
            .editMessageText(
                `分支: ${branch}\n已加入「等待打包 APK」队列。`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                },
            )
            .catch(() => { });
    } else if (action === 'apk_cancel') {
        // 用户选择「取消任务」：清理定时器，并从等待列表中移除（避免 /apk_start_all 仍然包含该分支）
        if (record && record.timer) {
            clearTimeout(record.timer);
        }
        pendingDecisions.delete(messageId);

        // 确保从 apk-pending.json 中移除该分支（无论之前是否已被自动/分析逻辑写入）
        apkTracker.remove(branch);

        console.log(chalk.cyan('用户选择取消 APK 任务，本次不会加入等待列表，分支:'), branch);

        bot
            .editMessageText(
                `分支: ${branch}\n已取消本次 APK 打包任务。`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                },
            )
            .catch(() => { });
    }
});

// 每天凌晨 4 点自动执行 /apk_start_all 并发送提醒
let lastCronRunDay = null; // 'YYYY-MM-DD'
setInterval(() => {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (hour === 4 && minute === 0 && lastCronRunDay !== today) {
        lastCronRunDay = today;
        const targetChatId = config.chatId;
        if (targetChatId) {
            sendSafe(targetChatId, '⏰ 凌晨 4 点自动触发：正在执行 /apk_start_all …');
            runApkStartAll(targetChatId);
            console.log(chalk.cyan('已执行凌晨 4 点自动 /apk_start_all'));
        }
    }
}, 60 * 1000);

// 是否打印 Telegram Bot 轮询网络错误（默认 false，避免 ECONNRESET 刷屏）
const ENABLE_TELEGRAM_POLLING_ERROR_LOG = false;

// 错误处理
bot.on('polling_error', (error) => {
    if (!ENABLE_TELEGRAM_POLLING_ERROR_LOG) {
        return;
    }
    console.error(chalk.red('Polling 错误:'), error.message);
});

// 优雅退出
process.on('SIGINT', () => {
    console.log(chalk.yellow('\n正在关闭 Bot...'));
    bot.stopPolling();
    process.exit(0);
});

