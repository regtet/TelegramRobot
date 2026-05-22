const { TelegramClient, LogLevel } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const input = require('input');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const chalk = require('chalk');
const axios = require('axios');
const apkTracker = require('./lib/apk/apk-tracker');
const apkBuiltHistory = require('./lib/apk/apk-built-history');
const branchPackageExpect = require('./lib/branch/branch-package-expect');
const branchAnnounceState = require('./lib/branch/branch-announce-state');
const branchGroupParse = require('./lib/branch/branch-group-auto-parse');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const { spawn } = require('child_process');

// 显式加载当前目录下的 .env，确保 AWS_* 等环境变量可用
dotenv.config({ path: path.join(__dirname, '.env') });

// APK 打包服务固定代理（与测试脚本 0.js 保持一致）
const PACK_SERVER_PROXY = {
    host: '127.0.0.1',
    port: 7890,
};

const config = require('./lib/core/config');
const Builder = require('./lib/build/builder');
const FileSplitter = require('./lib/build/file-splitter');
const { extractBranchNameFromFileName, readPackageIdFromBranch } = require('./lib/core/config-reader');
const { parsePackCommand } = require('./lib/core/parse-pack-command');
const { syncPackageIdWithGit } = require('./lib/git/package-id-sync');
const { renderConfigScreenshots, tryUnlinkPngs } = require('./lib/core/config-code-image');
const {
    parseAllowedChatIds,
    shouldHandleUserbotMessage,
} = require('./lib/core/chat-filter');
const userBotLog = require('./lib/logging/user-bot-logger');

// 是否启用“收到群消息自动打开 LX Music”功能
// 需要时把这个改成 true，不需要时改回 false
// const ENABLE_LX_MUSIC_ON_MESSAGE = true;
const ENABLE_LX_MUSIC_ON_MESSAGE = false;

// LX Music 桌面版路径（请确保路径存在）
const LX_MUSIC_PATH = 'D:\\Music\\lx-music-desktop\\lx-music-desktop.exe';

// 是否打印 Telegram MTProto 底层网络重连/超时等详细日志（默认 false，避免刷屏）
const ENABLE_TELEGRAM_NETWORK_LOG = false;

// 是否启用压缩包自动分析（读取配置、域名反解析等），默认 true
// 置为 true 时，自动上传 / 手动上传的 zip 都会触发「🔍 正在分析压缩包…」
const ENABLE_ZIP_ANALYZE = true;

// 是否解析群内复刻台公告并写入 branch-package-expect.json（默认开启，设 0 关闭）
const ENABLE_AUTO_BRANCHLIST_FROM_GROUP = process.env.ENABLE_AUTO_BRANCHLIST_FROM_GROUP !== '0';

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
const allowedChatIds = parseAllowedChatIds();
let selfUserId = null;

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

// 默认关闭 GramJS 内部的详细网络日志，避免 MTProto 重连刷屏；
// 如需排查 Telegram 连接问题，可将 ENABLE_TELEGRAM_NETWORK_LOG 改为 true。
if (!ENABLE_TELEGRAM_NETWORK_LOG && typeof client.setLogLevel === 'function') {
    try {
        client.setLogLevel(LogLevel.ERROR);
    } catch {
        // 兼容旧版本：退回字符串形式
        try {
            client.setLogLevel('error');
        } catch {
            // 忽略
        }
    }
}

// 多项目支持：WG-WEB（主仓库） + WGAME-WEB（备用仓库）
const projectAPath = config.buildProjectPath; // 例如 ../WG-WEB
const projectBPath = process.env.BUILD_PROJECT_PATH_B
    ? path.resolve(__dirname, process.env.BUILD_PROJECT_PATH_B)
    : null;

const builderA = new Builder(projectAPath, config.build); // WG-WEB
const builderB = projectBPath ? new Builder(projectBPath, config.build) : null;

// 默认 builder 仍指向 WG-WEB，用于旧逻辑（/branches 等），多项目场景统一走 projects 数组。
const builder = builderA;

// projects 遍历顺序决定了「优先在哪个仓库查分支」。
// 这里按你的需求：优先 WGAME-WEB，找不到再回退 WG-WEB。
const projects = [
    ...(builderB ? [{ name: 'WGAME-WEB', builder: builderB, path: projectBPath }] : []),
    { name: 'WG-WEB', builder: builderA, path: projectAPath },
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
/** zip 构建所在项目名（WG-WEB / WGAME-WEB），与 currentBuildBranch 配套 */
let currentBuildProjectName = '';
let buildQueue = []; // 普通打包（zip）排队列表
let currentBuildId = null; // 当前构建ID
let shouldCancelBuild = false; // 取消标志

// APK 打包队列（按顺序执行，避免多条消息交错）
let isApkBuilding = false;
let apkBuildQueue = [];
let currentApkBuildBranch = '';
let currentApkBuildProjectName = '';
let currentApkBuildChatId = null;

// 多分支「打包APK a b c」合并：未发汇总前再次触发会并入同一会话，只发一条 📊 统计
let apkBatchChunkQueue = []; // { resolvedTargets, chatId, applyApkBuiltDedup? }[]
let apkBatchWorkerPromise = null;
/** 最近一条群内「📊 APK 批量打包统计」的消息与统计快照（单分支补打成功后可 edit 回填） */
let apkBatchEditableSummaryRef = null; // { chatId, messageId, orderedBranches, outcomes } | null

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
    selfUserId = me && me.id != null ? me.id.toString() : null;
    console.log(chalk.cyan(`已登录: ${me.firstName} (${me.username || me.phone})`));
    if (selfUserId) {
        console.log(chalk.gray(`  本账号 ID: ${selfUserId}`));
    }

    if (allowedChatIds.size === 0) {
        console.log(chalk.yellow('\n⚠ 未配置 CHAT_ID'));
        console.log(chalk.yellow('请在 .env 中配置目标群组 ID'));
        console.log(chalk.gray('获取方法：在任意群组发送消息，查看控制台输出\n'));
    } else {
        console.log(
            chalk.green(
                `✓ 监听会话: ${Array.from(allowedChatIds).join(', ')}（含自己发出的打包指令）`,
            ),
        );
    }

    console.log(chalk.gray('\n等待命令...\n'));
    console.log(chalk.gray(`详细运行日志目录: ${userBotLog.LOGS_DIR}（user-bot.log 等）\n`));
    userBotLog.initOnStartup();

    /**
     * Promise 超时：避免 Telegram sendFile / 某分支整链永久挂起，占满批量 APK 的并发槽导致整批停滞。
     * 超时后 race 已结束，但底层 GramJS 请求可能仍在进行（无法强制中止），仅释放调度上的等待。
     */
    async function withTimeout(promise, ms, errLabel) {
        const n = Number(ms);
        if (!Number.isFinite(n) || n <= 0) {
            return promise;
        }
        let timer;
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => {
                reject(new Error(`${errLabel || '操作'}超时（>${Math.round(n / 1000)}s）`));
            }, n);
        });
        try {
            return await Promise.race([promise, timeoutPromise]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    const TELEGRAM_SEND_FILE_TIMEOUT_MS = parseInt(
        process.env.TELEGRAM_SEND_FILE_TIMEOUT_MS || String(8 * 60 * 1000),
        10,
    );
    const TELEGRAM_SEND_MESSAGE_TIMEOUT_MS = parseInt(
        process.env.TELEGRAM_SEND_MESSAGE_TIMEOUT_MS || String(120000),
        10,
    );
    /** 单分支从 pack 到发群整条链的上限（含轮询 list、下载、S3、Telegram），默认 55 分钟 */
    const APK_BRANCH_TOTAL_TIMEOUT_MS = parseInt(
        process.env.APK_BRANCH_TOTAL_TIMEOUT_MS || String(55 * 60 * 1000),
        10,
    );
    /**
     * 从打包机下载 APK 整段（含多次重试）的上限。避免 axios 流极慢/半开连接永不触发单次 timeout，
     * 导致某分支永久占住批量并发槽、queue 已空但 running≠0、整批无法结束（见 alfa-suer777 类现场）。
     */
    const APK_DOWNLOAD_TOTAL_TIMEOUT_MS = parseInt(
        process.env.APK_DOWNLOAD_TOTAL_TIMEOUT_MS || String(12 * 60 * 1000),
        10,
    );

    /**
     * 同一项目仓库（WG-WEB / WGAME-WEB）的工作区在同一时间只允许一个流程执行
     * （ZIP 构建、压缩包检测切分支、APK 预处理切分支等），避免并发 checkout 导致结果错乱。
     */
    const projectGitWorkChains = new Map();

    async function enqueueProjectGitWork(projectName, taskFn) {
        const key = projectName || 'UNKNOWN';
        const prev = projectGitWorkChains.get(key) || Promise.resolve();
        const run = prev.then(async () => taskFn());
        projectGitWorkChains.set(
            key,
            run.catch((e) => {
                console.log(
                    chalk.yellow(
                        `[${key}] 串行 Git 任务失败（已释放后续队列）: ${(e && e.message) || e}`,
                    ),
                );
            }),
        );
        return run;
    }

    /** 构建结束后若还有待分析的压缩包任务，顺带启动队列（仅靠 processFileTask 自驱动时，
     *  「构建中入队」会无人唤醒）
     */
    function scheduleNextQueuedFileAnalyze(delayMs = 1000) {
        if (isProcessingFile || fileProcessQueue.length === 0) {
            return;
        }
        const nextTask = fileProcessQueue.shift();
        const d = Number(delayMs);
        const wait = Number.isFinite(d) && d >= 0 ? d : 1000;
        setTimeout(() => {
            processFileTask(nextTask);
        }, wait);
    }

    /**
     * 压缩包检测是否应入队：全局只能跑一个 processFileTask；
     * 若另一仓库正在 zip 构建，则不同项目的检测可并行启动（由各自 Git 串行锁保证安全）。
     */
    function shouldQueueFileAnalyzeForProject(project) {
        if (isProcessingFile) {
            return true;
        }
        if (!isBuilding) {
            return false;
        }
        const pName = project && project.name;
        if (!pName || !currentBuildProjectName) {
            return true;
        }
        return pName === currentBuildProjectName;
    }

    /** 并发批量打包时合并对打包服务 /list 的并发请求（共用同一 in-flight Promise） */
    let packServerListInflight = null;
    async function fetchPackServerFileList() {
        if (packServerListInflight) {
            return packServerListInflight;
        }
        packServerListInflight = (async () => {
            try {
                const res = await axios.get('http://47.128.239.172:8000/list', {
                    timeout: 10000,
                    proxy: PACK_SERVER_PROXY,
                });
                const files = res.data && Array.isArray(res.data.files) ? res.data.files : [];
                userBotLog.append('LIST', `OK files=${files.length}`);
                return files;
            } catch (error) {
                const msg = (error && error.message) || String(error);
                userBotLog.append('LIST', `FAIL ${msg}`);
                throw error;
            } finally {
                packServerListInflight = null;
            }
        })();
        return packServerListInflight;
    }

    function inferApkFailureStage(error) {
        const m = (error && error.message) || String(error);
        if (/S3|AWS|amazonaws|PutObject|上传到 S3|socket hang up|TimeoutError/i.test(m)) return '上传 S3';
        if (/Telegram sendFile|Telegram sendMessage|Telegram 通知失败|整链超时/i.test(m)) return 'Telegram 发群';
        if (/未找到已打包|打包结果|\/list|访问 \/list/i.test(m)) return '等待打包结果';
        if (/下载 APK.*超时|下载.*超时/i.test(m)) return '下载 APK';
        if (/下载 APK|download/i.test(m)) return '下载 APK';
        if (/Logo|gulu_top/i.test(m)) return 'Logo 处理';
        if (/切换分支|checkout|git/i.test(m)) return 'Git 分支';
        return '';
    }

    function buildApkFailureTelegramMessage(projectName, branchName, error) {
        const errorMsg = (error && error.message) || String(error);
        const stage = inferApkFailureStage(error);
        const stageLine = stage ? `🔧 环节: ${stage}\n` : '';
        return (
            `❌ APK 打包失败\n\n` +
            stageLine +
            `📁 项目: ${projectName}\n` +
            `🌿 分支: ${branchName}\n` +
            `📝 错误信息: ${errorMsg}`
        );
    }

    /**
     * 群内复刻台任务：第 1 条单行域名 → pending；第 2 条复刻台+分包ID → 写入期望分包（可穿插他人消息）
     */
    function handleGroupReplicaAnnounce(chatIdStr, trimmedText, senderId) {
        if (!ENABLE_AUTO_BRANCHLIST_FROM_GROUP || !trimmedText) return;

        const hint = branchGroupParse.tryParseBranchNameHintMessage(trimmedText);
        if (hint) {
            branchAnnounceState.setPendingBranchHint(chatIdStr, senderId, hint);
            console.log(
                chalk.cyan(
                    `✅ [公告] 已记录命名参考: ${hint.branchNameHint}（发送者 ${senderId || '-'}，等待复刻台分包行）`,
                ),
            );
            return;
        }

        const pending = branchAnnounceState.getPendingBranchHint(chatIdStr, senderId);
        const task = branchGroupParse.tryParseReplicaConfigMessage(trimmedText, pending);
        if (!task) return;

        branchPackageExpect.setFromAnnounceTask(task);
        branchAnnounceState.clearPendingBranchHint(chatIdStr, senderId);
        const seriesPart = task.series ? `，系列 ${task.series}` : '';
        console.log(
            chalk.green(
                `✅ [公告] 已记录 ${task.recordKey} → packageId ${task.packageId}${seriesPart}（发送者 ${senderId || '-'}，匹配 token ${task.matchTokens.length} 个）`,
            ),
        );
    }

    async function sendPackageMismatchAlert(chatId, { fileName, branchName, pkgWarn }) {
        if (!pkgWarn || !pkgWarn.html) return;
        const header = branchPackageExpect.escapeHtml(
            `📦 ${fileName || '压缩包'}\n🌿 分支: ${branchName || '-'}\n`,
        );
        try {
            await withTimeout(
                client.sendMessage(chatId, {
                    message: header + pkgWarn.html.trim(),
                    parseMode: 'html',
                    linkPreview: false,
                }),
                TELEGRAM_SEND_MESSAGE_TIMEOUT_MS,
                `Telegram sendMessage(分包不一致告警) ${branchName}`,
            );
        } catch (err) {
            console.log(
                chalk.yellow(
                    `[${branchName}] 分包不一致单独告警发送失败: ${(err && err.message) || err}`,
                ),
            );
        }
    }

    /** APK 预处理阶段 Pull 失败等：不向群内发长篇 Git 报错（与压缩包检测一致，仅日志） */
    function shouldSuppressTelegramForApkPrepGitError(error) {
        const m = String((error && error.message) || error || '');
        if (/Pull 多次失败无法确认最新代码/i.test(m)) {
            return true;
        }
        if (
            /Command failed:\s*git pull/i.test(m) &&
            /unmerged|pulling is not possible/i.test(m)
        ) {
            return true;
        }
        return false;
    }

    // 监听新消息
    client.addEventHandler(async (event) => {
        try {
            const message = event.message;

            // 只处理文本消息
            if (!message || !message.text) return;

            const text = message.text.trim();
            const senderId =
                message.senderId != null && typeof message.senderId.toString === 'function'
                    ? message.senderId.toString()
                    : '';
            const chatIdStr = message.chatId.toString();

            if (!shouldHandleUserbotMessage(message, allowedChatIds, selfUserId)) {
                return;
            }

            console.log(chalk.gray(message.out ? '收到自己发出的指令:' : '收到目标群消息:'));
            console.log(chalk.gray('  发送者ID:'), senderId);
            console.log(chalk.gray('  群组ID:'), chatIdStr);
            console.log(chalk.gray('  消息:'), text);

            handleGroupReplicaAnnounce(chatIdStr, text, senderId);

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

            // 移除 bot 用户名（仅用于后续群内其他命令）
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
                    const who =
                        currentBuildProjectName && currentBuildBranch
                            ? `${currentBuildProjectName} / ${currentBuildBranch}`
                            : currentBuildBranch || '…';
                    queueMessage += `🔄 ${who}\n\n`;
                } else {
                    queueMessage += `✅ 空闲\n\n`;
                }

                if (buildQueue.length > 0) {
                    queueMessage += `等待中 (${buildQueue.length}个):\n`;
                    buildQueue.forEach((item, index) => {
                        const pname = item.project && item.project.name ? `${item.project.name} / ` : '';
                        queueMessage += `${index + 1}. ${pname}${item.branchName}\n`;
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
                await enqueueApkBuild(branchNameForApk, message.chatId, { applyApkBuiltDedup: false });
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

            // 文本命令：打包APK 分支名（例如：打包APK wg-burgguer）；支持多行正文中单独一行以「打包APK」开头
            let apkCommandLine = null;
            if (trimmedText.startsWith('打包APK')) {
                apkCommandLine = trimmedText;
            } else {
                const lines = trimmedText
                    .split(/\r?\n/)
                    .map((l) => l.trim())
                    .filter((l) => l.length > 0);
                apkCommandLine = lines.find((l) => l.startsWith('打包APK')) || null;
            }

            if (apkCommandLine) {
                const branchTextForApk = apkCommandLine.substring('打包APK'.length).trim();

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

                const applyApkBuiltDedup = await isApkPackTriggerFromBot(message);

                // 单分支走 APK 队列入口，避免触发批量统计；多分支仍走批量流程
                if (apkBranchNames.length === 1) {
                    await enqueueApkBuild(apkBranchNames[0], message.chatId, { applyApkBuiltDedup });
                    return;
                }

                // 批量打包：先依次准备每个分支的配置与 Logo，再并发触发打包接口 + 下载 + 上传
                await handleBatchApkBuild(apkBranchNames, message.chatId, applyApkBuiltDedup);
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
                return;
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

            // 立刻删除用户输入的打包指令，实现静默触发
            if (message.id) {
                try {
                    await client.deleteMessages(message.chatId, [message.id], { revoke: true });
                } catch (e) {
                    console.log(chalk.yellow('删除打包指令消息失败（可忽略）:', e.message));
                }
            }

            const packItems = parsePackCommand(trimmedText);

            if (packItems.length === 0) {
                console.log(chalk.yellow('打包命令未解析到有效分支名'));
                return;
            }

            const branchNames = packItems.map((item) =>
                item.branch.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '').trim(),
            );

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

            for (const item of packItems) {
                const name = item.branch.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '').trim();
                try {
                    const resolved = await resolveProjectAndBranch(name);
                    if (resolved) {
                        resolvedBuildTargets.push({
                            inputName: name,
                            project: resolved.project,
                            actualBranchName: resolved.actualBranchName,
                            packageId:
                                item.packageId != null && Number.isFinite(item.packageId)
                                    ? item.packageId
                                    : null,
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
                console.log(
                    chalk.yellow(
                        `⚠ 以下分支在两个仓库中都不存在，将跳过: ${invalidBuildBranches.join(', ')}`,
                    ),
                );
            }

            if (resolvedBuildTargets.length === 0) {
                console.log(chalk.red(`❌ 所有分支都不存在，取消打包`));
                return;
            }

            const validBranches = resolvedBuildTargets.map(t => t.actualBranchName);
            console.log(chalk.green(`✓ 有效分支: ${validBranches.join(', ')}`));
            console.log(chalk.cyan(`输入 有效分支: ${validBranches.join(', ')} 打包中...`));

            // 删除用户输入的打包命令，改为静默触发
            const msgId = message.id;
            if (msgId) {
                try {
                    await client.deleteMessages(message.chatId, [msgId], { revoke: true });
                } catch (e) {
                    console.log(chalk.yellow('删除打包指令消息失败（可忽略）:', e.message));
                }
            }

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

            // 处理多个分支（只处理新的有效分支）
            for (let i = 0; i < newTargets.length; i++) {
                const { project, actualBranchName, packageId } = newTargets[i];
                const branchName = actualBranchName;
                const buildId = Date.now().toString() + '_' + i;

                if (isBuilding || (i > 0)) {
                    buildQueue.push({
                        buildId,
                        branchName,
                        project,
                        packageId,
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
                currentBuildProjectName = project.name;
                currentBuildId = buildId;

                console.log(chalk.cyan(`\n开始打包项目 ${project.name} 中的分支: ${branchName} (共${validBranches.length}个)`));
                console.log(chalk.gray(`触发用户: ${senderId}\n`));

                // 执行构建流程（异步，不等待）
                (async () => {
                    try {
                        await executeBuild(project, branchName, senderId, message.chatId, {
                            packageId,
                        });
                    } catch (error) {
                        console.error(chalk.red('打包失败:'), error);
                    }

                    // 释放打包状态并处理下一个
                    isBuilding = false;
                    currentBuildBranch = '';
                    currentBuildProjectName = '';
                    currentBuildId = null;

                    setTimeout(() => {
                        processNextInQueue();
                        scheduleNextQueuedFileAnalyze(1000);
                    }, 2000);
                })();
            }

            return;

        } catch (error) {
            console.error(chalk.red('处理消息时出错:'), error);
        }
    }, new NewMessage({ incoming: true, outgoing: true }));

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

            if (!shouldHandleUserbotMessage(message, allowedChatIds, selfUserId)) {
                return;
            }

            // 手动上传压缩包：根据文件名解析分支并触发与自动上传相同的“分析压缩包”流程（可通过 ENABLE_ZIP_ANALYZE 关闭）
            if (!ENABLE_ZIP_ANALYZE) {
                console.log(chalk.gray(`收到手动上传压缩包，但已关闭自动分析功能，已跳过: ${fileName}`));
                return;
            }

            const branchFromFile = extractBranchNameFromFileName(fileName);
            if (!branchFromFile) {
                console.log(chalk.gray(`手动上传压缩包但未能从文件名解析分支，已跳过: ${fileName}`));
                return;
            }

            let resolved;
            try {
                resolved = await resolveProjectAndBranch(branchFromFile);
            } catch (e) {
                console.log(chalk.yellow(`在项目中解析手动上传压缩包对应分支失败: ${branchFromFile} - ${e.message}`));
            }

            if (!resolved) {
                console.log(chalk.red(`❌ 手动上传压缩包对应分支在 WG-WEB / WGAME-WEB 中均未找到: ${branchFromFile}`));
                return;
            }

            const fileTask = {
                fileName,
                branchName: branchFromFile,
                actualBranchName: resolved.actualBranchName,
                project: resolved.project,
                chatId: message.chatId,
                timestamp: new Date(),
            };

            if (shouldQueueFileAnalyzeForProject(resolved.project)) {
                fileProcessQueue.push(fileTask);
            } else {
                (async () => {
                    await processFileTask(fileTask);
                })();
            }
            return;
        } catch (error) {
            console.error(chalk.red('处理文件消息时出错:'), error);
        }
    }, new NewMessage({ incoming: true, outgoing: true }));

    // 处理文件任务（从队列中取出并处理）
    async function processFileTask(task) {
        const { fileName, branchName, actualBranchName, project, chatId } = task;

        // 设置处理状态
        isProcessingFile = true;

        try {
            await enqueueProjectGitWork(project.name, async () => {
                // 切换到该分支并拉取最新代码，确保读取的是远程最新配置
                const currentBranch = await project.builder.runCommand('git rev-parse --abbrev-ref HEAD');
                let originalBranch = currentBranch.success ? currentBranch.output.trim() : null;

                try {
                    const targetBranch = actualBranchName;

                    if (originalBranch === targetBranch) {
                        console.log(chalk.gray(`当前已在分支 ${targetBranch}，拉取最新代码...`));
                    } else {
                        if (config.build.autoFetchPull) {
                            console.log(chalk.cyan(`📥 [${project.name}] 获取远程分支信息...`));
                            const fetchResult = await project.builder.runCommand('git fetch --all');
                            if (!fetchResult.success) {
                                console.log(chalk.yellow(`⚠ Fetch 失败，继续尝试切换分支...`));
                            } else {
                                console.log(chalk.green(`✓ Fetch 完成`));
                            }
                        }

                        await safeCheckoutBranch(project, targetBranch);
                    }

                    if (config.build.autoFetchPull) {
                        console.log(chalk.cyan(`📥 [${project.name}] 拉取分支最新代码...`));
                        const pullMaxAttempts = 3;
                        const pullDelayMs = 3000;
                        let pullResult = null;

                        for (let attempt = 1; attempt <= pullMaxAttempts; attempt++) {
                            pullResult = await project.builder.runCommand('git pull');
                            if (pullResult && pullResult.success) break;
                            if (attempt < pullMaxAttempts) {
                                await new Promise(r => setTimeout(r, pullDelayMs));
                            }
                        }

                        if (!pullResult || !pullResult.success) {
                            console.log(
                                chalk.red(
                                    `❌ Pull 多次失败 ${project.name}/${actualBranchName}: ${(pullResult && pullResult.error) || '未知错误'}`,
                                ),
                            );
                            userBotLog.append(
                                'ANALYZE',
                                `Pull 失败不输出检测结果 ${project.name}/${actualBranchName}: ${(pullResult && pullResult.error) || '未知'}`,
                            );
                            // 不向群内发 Pull 失败文案，避免与「误报」说明刷屏；仅日志
                            return;
                        }

                        console.log(chalk.green(`✓ 代码已更新到最新`));
                    }

                    console.log(chalk.cyan(`📖 [${project.name}] 读取配置文件...`));
                    const result = await readPackageIdFromBranch(project.path, actualBranchName);

                    if (result.success) {
                        const envText = result.debug !== undefined
                            ? (result.debug ? '测试服' : '正式服')
                            : '未知';
                        const debugFlagText = result.debug !== undefined
                            ? String(result.debug)
                            : '未检测到';

                        const appName = result.appName || '未检测到';

                        const mainDomains = Array.isArray(result.mainDomains) ? result.mainDomains : [];

                        let msg =
                            `📦 ${fileName}\n` +
                            `📁 项目: ${project.name} | 分支: ${actualBranchName}\n` +
                            `📱 APK: ${appName}\n` +
                            `🆔 Package: ${result.packageId}\n` +
                            `🎮 环境: ${envText} (debug=${debugFlagText})`;

                        if (result.debug !== false) {
                            msg +=
                                `\n\n⚠️ 警告：debug 不为 false（当前：${debugFlagText}），非正式服或未检测到，请确认环境与分包是否正确。`;
                        }

                        const seenDomains = new Set();
                        const uniqueDomains = mainDomains
                            .map(d => String(d).trim())
                            .filter(Boolean)
                            .filter((d) => {
                                const key = d.toLowerCase();
                                if (seenDomains.has(key)) return false;
                                seenDomains.add(key);
                                return true;
                            });

                        if (uniqueDomains.length > 0) {
                            msg += `\n\n🌐 主域名:\n`;
                            uniqueDomains.forEach((d) => {
                                msg += `- ${d}\n`;
                            });
                            msg = msg.trimEnd();
                        }

                        const pkgWarn = branchPackageExpect.buildExpectationWarnings(actualBranchName, {
                            packageId: result.packageId,
                            debug: result.debug,
                        });
                        if (pkgWarn.plain) {
                            console.log(chalk.red(pkgWarn.plain.trim()));
                        }

                        console.log(
                            chalk.green(
                                `✅ 分支 ${actualBranchName} 当前分支分包ID packageId: ${result.packageId}, appName: ${appName}, debug: ${result.debug !== undefined ? result.debug : '未检测到'}`
                            )
                        );

                        pendingApkOptions.set(actualBranchName, {
                            packageId: result.packageId,
                            appName,
                            appNameSlug: result.appNameSlug,
                            primaryDomain: result.primaryDomain,
                        });

                        try {
                            apkTracker.addOrUpdate(actualBranchName, {
                                source: 'analyzed',
                                fileName,
                                chatId,
                                packageId: result.packageId || null,
                                appName,
                                appNameSlug: result.appNameSlug || null,
                                primaryDomain: result.primaryDomain || null,
                            });
                            console.log(
                                chalk.gray(
                                    `已将分支 ${actualBranchName} 的 APK 配置信息写入 apk-pending.json`
                                )
                            );
                        } catch (err) {
                            console.log(
                                chalk.yellow(
                                    `写入 apk-pending.json 失败（可忽略，不影响本次打包）：${err.message}`
                                )
                            );
                        }

                        try {
                            await withTimeout(
                                client.sendMessage(chatId, {
                                    message: branchPackageExpect.escapeHtml(msg),
                                    parseMode: 'html',
                                    linkPreview: false,
                                }),
                                TELEGRAM_SEND_MESSAGE_TIMEOUT_MS,
                                `Telegram sendMessage(压缩包检测) ${actualBranchName}`,
                            );
                        } catch (error) {
                            try {
                                await client.sendMessage(chatId, { message: msg, linkPreview: false });
                            } catch (err) {
                                console.log(chalk.yellow('发送压缩包检测结果失败:', err.message));
                            }
                        }

                        if (pkgWarn.html) {
                            await sendPackageMismatchAlert(chatId, {
                                fileName,
                                branchName: actualBranchName,
                                pkgWarn,
                            });
                        }
                    } else {
                        const errorMsg =
                            `📦 ${fileName}\n` +
                            `📁 项目: ${project.name} | 分支: ${actualBranchName}\n` +
                            `❌ 未检测到 packageId 配置`;
                        console.log(chalk.red(`❌ 分支 ${actualBranchName} 当前分支 未检测到packageId配置`));

                        try {
                            await client.sendMessage(chatId, {
                                message: errorMsg,
                                parseMode: 'Markdown'
                            });
                        } catch (error) {
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

                    try {
                        await client.sendMessage(chatId, {
                            message: `处理文件失败: ${error.message}`
                        });
                    } catch (err) {
                        console.log(chalk.yellow('发送消息失败:', err.message));
                    }
                }
            });
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
    async function uploadFileToS3(
        localFilePath,
        key,
        contentType = 'application/octet-stream',
        uploadTimeoutMs = 60000,
    ) {
        if (!S3_BUCKET) {
            userBotLog.append('S3', '未配置 S3_BUCKET');
            console.log(chalk.red('❌ 未配置 S3_BUCKET，无法上传到 S3'));
            throw new Error('S3_BUCKET 未配置');
        }

        if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
            userBotLog.append('S3', '未配置 AWS 凭证');
            console.log(chalk.red('❌ 未配置 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY，无法上传到 S3'));
            throw new Error('AWS 凭证未配置');
        }

        const maxAttempts = 10;
        const delayMs = 3000;
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            userBotLog.append('S3', `尝试 ${attempt}/${maxAttempts} bucket=${S3_BUCKET} key=${key}`);

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
                }, uploadTimeoutMs);

                try {
                    await s3Client.send(command, { abortSignal: abortController.signal });
                } finally {
                    clearTimeout(timeoutId);
                }

                userBotLog.append('S3', `成功 key=${key}`);
                console.log(chalk.green(`✅ 上传到 S3 成功: ${key}`));

                const publicUrl = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`;
                return { key, url: publicUrl };
            } catch (error) {
                lastError = error;
                const msg = (error && error.message) || '';
                const code = (error && error.code) || (error && error.cause && error.cause.code) || '';

                userBotLog.append('S3', `失败 ${attempt}/${maxAttempts} code=${code} msg=${msg}`);

                const isAbortError =
                    (error && error.name === 'AbortError') ||
                    /Request aborted/i.test(msg);

                const isAwsRequestTimeout =
                    (error && (error.Code === 'RequestTimeout' || error.name === 'RequestTimeout')) ||
                    /Your socket connection to the server was not read from or written to within the timeout period\. Idle connections will be closed\./i.test(msg);

                const isInvalidHeaderValue =
                    (error && error.code === 'ERR_HTTP_INVALID_HEADER_VALUE') ||
                    /Invalid value "undefined" for header "x-amz-decoded-content-length"/i.test(msg);

                const retryable =
                    isAbortError ||
                    isAwsRequestTimeout ||
                    isInvalidHeaderValue ||
                    /Client network socket disconnected before secure TLS connection was established/i.test(msg) ||
                    code === 'ECONNRESET' ||
                    code === 'ETIMEDOUT' ||
                    code === 'EPIPE' ||
                    code === 'EAI_AGAIN' ||
                    /ECONNRESET/i.test(msg) ||
                    /ETIMEDOUT/i.test(msg) ||
                    /EAI_AGAIN/i.test(msg) ||
                    /socket hang up/i.test(msg) ||
                    /network error/i.test(msg) ||
                    /non-retryable streaming request/i.test(msg);

                if (!retryable || attempt === maxAttempts) {
                    userBotLog.append('S3', `终止重试 retryable=${retryable} last=${msg}`);
                    console.log(chalk.red(`❌ 上传到 S3 失败（已写日志）: ${key}`));
                    break;
                }

                userBotLog.append('S3', `${delayMs / 1000}s 后重试`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        throw lastError || new Error('上传到 S3 失败（未知错误）');
    }

    // 清理本地分支（保留 main / master）：对每个已配置项目各清一遍
    async function cleanupLocalBranches() {
        for (const proj of projects) {
            if (!proj || !proj.builder) {
                continue;
            }

            console.log(chalk.cyan(`🧹 清理本地分支 [${proj.name}]（保留 main/master）...`));

            const branchesResult = await proj.builder.runCommand('git branch');
            if (!branchesResult.success) {
                console.log(chalk.yellow(`⚠ [${proj.name}] 获取分支列表失败`));
                continue;
            }

            const branches = branchesResult.output
                .split('\n')
                .map(b => b.trim())
                .filter(b => b.length > 0 && !b.startsWith('*'))
                .filter(b => b !== 'main' && b !== 'master');

            if (branches.length === 0) {
                console.log(chalk.gray(`✓ [${proj.name}] 没有需要清理的分支`));
                continue;
            }

            let deletedCount = 0;
            for (const branch of branches) {
                if (
                    isBuilding &&
                    currentBuildProjectName === proj.name &&
                    currentBuildBranch === branch
                ) {
                    console.log(chalk.gray(`跳过删除 [${proj.name}] ${branch}（正在 zip 构建中）`));
                    continue;
                }

                const deleteResult = await proj.builder.runCommand(`git branch -D ${branch}`);
                if (deleteResult.success) {
                    deletedCount++;
                    console.log(chalk.gray(`✓ [${proj.name}] 已删除分支: ${branch}`));
                } else {
                    console.log(chalk.yellow(`⚠ [${proj.name}] 删除分支失败: ${branch} - ${deleteResult.error}`));
                }
            }

            if (deletedCount > 0) {
                console.log(chalk.green(`✓ [${proj.name}] 已清理 ${deletedCount} 个本地分支`));
            }
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
            return;
        }

        const results = [];

        try {
            // 逐个检测每个分支（注意：可能来自不同项目）
            for (let i = 0; i < resolvedInfos.length; i++) {
                const info = resolvedInfos[i];
                const { project, actualBranchName } = info;

                console.log(chalk.cyan(`\n[${i + 1}/${resolvedInfos.length}] 在项目 ${project.name} 中检测分支: ${actualBranchName}`));

                await enqueueProjectGitWork(project.name, async () => {
                    try {
                        const currentBranch = await project.builder.runCommand('git rev-parse --abbrev-ref HEAD');
                        let originalBranch = currentBranch.success ? currentBranch.output.trim() : null;

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

                            await safeCheckoutBranch(project, actualBranchName);
                        }

                        if (config.build.autoFetchPull) {
                            console.log(chalk.cyan(`📥 [${project.name}] 拉取分支最新代码...`));
                            const pullMaxAttempts = 3;
                            const pullDelayMs = 3000;
                            let pullResult = null;
                            for (let attempt = 1; attempt <= pullMaxAttempts; attempt++) {
                                pullResult = await project.builder.runCommand('git pull');
                                if (pullResult && pullResult.success) break;
                                if (attempt < pullMaxAttempts) {
                                    await new Promise(r => setTimeout(r, pullDelayMs));
                                }
                            }

                            if (!pullResult || !pullResult.success) {
                                const errDetail =
                                    (pullResult && pullResult.error) || '未知错误';
                                console.log(chalk.red(`❌ [${project.name}] Pull 多次失败: ${errDetail}`));
                                userBotLog.append(
                                    'DETECT',
                                    `Pull 失败不输出检测结果 ${project.name}/${actualBranchName}: ${errDetail}`,
                                );
                                // 不写入 results，汇总消息中不展示「未能拉取」类说明
                                return;
                            }
                            console.log(chalk.green(`✓ [${project.name}] 代码已更新到最新`));
                        }

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
                });

                try {
                    await cleanupLocalBranches();
                } catch (error) {
                    console.log(chalk.yellow(`清理分支失败: ${error.message}`));
                }
            }

            // 汇总结果并发送消息（Pull 失败等未进入 results 的分支不向群内输出）
            const total = results.length;
            let msg = '';

            if (total === 0 && invalidInfos.length === 0) {
                console.log(
                    chalk.yellow(
                        '检测汇总：无可用结果（例如全部 Pull 失败，已仅写日志、不向群内发汇总）',
                    ),
                );
            } else {
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

                    if (result.debug !== false) {
                        msg += `⚠️ 警告：debug 不为 false（${result.debugValue}），非正式服或未检测到，请确认环境与分包是否正确。\n\n`;
                    }

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

                    const detectWarn = branchPackageExpect.buildExpectationWarnings(result.branchName, {
                        packageId: result.packageId,
                        debug: result.debug,
                    });
                    msg += detectWarn.plain;
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

                const resolvedRemote = await proj.builder.resolveRemoteBranchName(trimmedBranch);
                if (resolvedRemote) {
                    console.log(chalk.cyan(`✓ [${proj.name}] 通过 ls-remote 确认远端分支存在: ${resolvedRemote}`));
                    return {
                        project: proj,
                        actualBranchName: resolvedRemote,
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

    /** 群内由「打包机器人」账号发出的「打包APK」视为自动任务（如凌晨 /apk_start_all），才做 APK 去重 */
    async function isApkPackTriggerFromBot(message) {
        if (!message || message.senderId == null) return false;
        try {
            const ent = await client.getEntity(message.senderId);
            return Boolean(ent && ent.className === 'User' && ent.bot);
        } catch {
            return false;
        }
    }

    // 将 APK 打包任务加入队列，按顺序执行（按钮、文本命令、Bot 代发的打包APK 等）
    async function enqueueApkBuild(branchName, chatId, { applyApkBuiltDedup = false } = {}) {
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
            return;
        }

        // 入队（使用解析后的实际分支名 + 项目信息）
        apkBuildQueue.push({
            branchName: resolvedActualBranch,
            displayBranch,
            chatId,
            projectName: displayProject,
            applyApkBuiltDedup,
        });

        console.log(chalk.cyan(`📋 APK 打包加入队列: [${displayProject}] ${displayBranch}`));

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

        try {
            await triggerApkBuildForBranch(task.branchName, task.chatId, null, {
                applyApkBuiltDedup: Boolean(task.applyApkBuiltDedup),
            });
        } catch (error) {
            userBotLog.append('QUEUE', `APK 队列任务失败: ${(error && error.message) || error}`);
            console.log(chalk.red('❌ APK 队列任务失败（详情见日志）'));
        } finally {
            isApkBuilding = false;
            currentApkBuildBranch = '';
            currentApkBuildProjectName = '';
            currentApkBuildChatId = null;

            setTimeout(() => processNextApkInQueue(), 2000);
        }
    }

    // 统一触发 APK 打包的入口（由队列处理器调用，或单次直接调用）
    async function triggerApkBuildForBranch(branchName, chatId, existingStatusMsgId, extra = {}) {
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

        // 不再单独发送“构建任务已创建”消息，保持群消息简洁
        const statusMsgId = null;

        // 这里不再预先读取配置，所有与 appDownPath / proxyShareUrlList 相关的信息
        // 都在 handleBuildApkForBranch 中，在切换到目标分支之后统一读取，避免串分支。
        const options = {
            packageId: null,
            appName: null,
            appNameSlug: null,
            primaryDomain: null,
            statusMsgId,
            applyApkBuiltDedup: Boolean(extra && extra.applyApkBuiltDedup),
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
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent':
                            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
                        'Accept': '*/*',
                        'Accept-Language': 'zh-CN,zh;q=0.9',
                        'Connection': 'keep-alive',
                    },
                    timeout: 60000, // 不动原有超时时间
                    proxy: PACK_SERVER_PROXY,
                });

                console.log(chalk.green('✅ 打包接口触发成功'));
                return;
            } catch (error) {
                userBotLog.append('PACK', `调用 /pack 失败 ${attempt}/${maxAttempts}: ${error.message}`);
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
            userBotLog.append('DOWNLOAD', `APK 下载 ${attempt}/${maxAttempts} ${url}`);

            try {
                // 每次下载尝试设置 15 秒超时，超时会主动中止请求并记为一次失败
                const response = await axios.get(url, {
                    responseType: 'stream',
                    timeout: timeoutMs,
                    proxy: PACK_SERVER_PROXY,
                });

                await new Promise((resolve, reject) => {
                    try {
                        if (fs.existsSync(localPath)) {
                            fs.unlinkSync(localPath);
                        }
                    } catch {
                        // 忽略，交给后续写入阶段处理
                    }
                    const writer = fs.createWriteStream(localPath);
                    response.data.pipe(writer);
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });

                userBotLog.append('DOWNLOAD', `完成 ${localPath}`);
                console.log(chalk.green(`📦 APK 下载完成`));
                return;
            } catch (error) {
                const msg = (error && error.message) || '';
                const code = error && error.code;

                userBotLog.append('DOWNLOAD', `失败 ${attempt}/${maxAttempts} ${msg}`);

                const isRetryable =
                    code === 'ECONNRESET' ||
                    code === 'ETIMEDOUT' ||
                    code === 'EPERM' ||
                    code === 'EACCES' ||
                    code === 'EBUSY' ||
                    /socket hang up/i.test(msg) ||
                    /timeout/i.test(msg) ||
                    /operation not permitted/i.test(msg);

                if (!isRetryable || attempt === maxAttempts) {
                    throw error;
                }

                await new Promise(r => setTimeout(r, retryDelayMs));
            }
        }
    }

    // 轮询外部接口，等待对应 APK 打包完成
    // 为了减轻打包服务压力，默认每 3 分钟查询一次 /list，最多查询 10 次（约 30 分钟）
    async function waitForPackedApk(appNameSlug, triggerTimeMs, maxAttempts = 10, intervalMs = 180000, chatId, statusMsgId, branchName) {
        const slugForPack = (appNameSlug || '').toLowerCase();
        const targetName = `app-${slugForPack}.apk`;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            userBotLog.append('APK', `检查打包结果 ${branchName || slugForPack} ${attempt}/${maxAttempts}`);

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
                    files = await fetchPackServerFileList();
                    break;
                } catch (error) {
                    const msg = (error && error.message) || '';
                    userBotLog.append(
                        'LIST',
                        `轮询失败 attempt=${attempt}/${maxAttempts} ${msg}，${intervalMs / 1000}s 后重试`,
                    );
                    await new Promise(r => setTimeout(r, intervalMs));
                    continue;
                }
            }

            // 仅匹配正式签名的 app-{slug}.apk，且 modified 时间不早于本次打包触发时间
            const match = files.find(f => f && f.name === targetName);

            if (match && match.modified) {
                // modified 是格林尼治时间字符串，例如 "2026-02-25 08:58:27"
                // 将其转换为 UTC 毫秒进行比较，只接受触发时间之后生成的包
                const modifiedStr = String(match.modified).replace(' ', 'T') + 'Z';
                const modifiedMs = Date.parse(modifiedStr);

                if (!isNaN(modifiedMs) && modifiedMs >= triggerTimeMs) {
                    userBotLog.append('APK', `找到 APK ${match.name} modified=${match.modified}`);
                    console.log(chalk.green(`✅ APK 就绪: ${match.name}`));
                    return match; // { url, name, modified, size }
                }

                userBotLog.append('APK', `略过旧包 ${match.name} modified=${match.modified}`);
            }

            await new Promise(r => setTimeout(r, intervalMs));
        }

        throw new Error(`在 ${maxAttempts} 次轮询内未找到已打包 APK（app-${slugForPack}.apk）`);
    }

    function tryUnlinkIfExists(filePath) {
        if (!filePath || typeof filePath !== 'string') return;
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch {
            // ignore
        }
    }

    // 预处理：为某个分支准备 APK 打包所需的上下文（切分支、拉代码、读配置、上传 Logo）
    async function prepareApkContext(project, branchName, initialPackageId) {
        return enqueueProjectGitWork(project.name, () =>
            prepareApkContextCore(project, branchName, initialPackageId),
        );
    }

    async function prepareApkContextCore(project, branchName, initialPackageId) {
        console.log(chalk.cyan(`\n🔧 为项目 ${project.name} 的分支 ${branchName} 准备 APK 打包上下文`));

        let appName = null;
        let appNameSlug = null;
        let primaryDomain = null;
        let packageId = initialPackageId || null;
        let logoInfo = null;
        let logoLocalPath = '';
        let logoSourceType = 'primary';

        const currentBranch = await project.builder.runCommand('git rev-parse --abbrev-ref HEAD');
        let originalBranch = currentBranch.success ? currentBranch.output.trim() : null;

        // 1. 切分支 + 拉代码
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

            await safeCheckoutBranch(project, branchName);
        } else {
            console.log(chalk.gray(`当前已在分支 ${branchName}`));
        }

        if (config.build.autoFetchPull) {
            console.log(chalk.cyan('📥 拉取分支最新代码...'));
            const pullMaxAttempts = 3;
            const pullDelayMs = 3000;
            let pullResult = null;
            for (let attempt = 1; attempt <= pullMaxAttempts; attempt++) {
                pullResult = await project.builder.runCommand('git pull');
                if (pullResult && pullResult.success) break;
                if (attempt < pullMaxAttempts) {
                    await new Promise(r => setTimeout(r, pullDelayMs));
                }
            }

            if (!pullResult || !pullResult.success) {
                throw new Error(
                    `Pull 多次失败无法确认最新代码 (${(pullResult && pullResult.error) || '未知错误'})`,
                );
            }
            console.log(chalk.green('✓ 代码已更新到最新'));
        }

        // 2. 从当前分支配置读取 appDownPath / proxyShareUrlList / packageId
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

        // 3. 生成并上传 Logo
        try {
            const primaryLogoRelativePath = path.join('home', 'img', 'configFile', 'gulu_top.avif');
            const fallbackLogoRelativePath = path.join(
                'src',
                'assets',
                'img',
                'configFile',
                'gulu_top.avif',
            );
            const primaryLogoPath = path.join(project.path, primaryLogoRelativePath);
            const fallbackLogoPath = path.join(project.path, fallbackLogoRelativePath);
            let logoPath = primaryLogoPath;

            if (!fs.existsSync(logoPath)) {
                if (fs.existsSync(fallbackLogoPath)) {
                    logoPath = fallbackLogoPath;
                    logoSourceType = 'fallback';
                    console.log(
                        chalk.yellow(
                            `⚠ 第一位置未找到 Logo，改用备用路径: ${fallbackLogoRelativePath}`,
                        ),
                    );
                } else {
                    const errText =
                        `未找到 Logo 文件，打包已中止。请在仓库中放置以下任一文件:\n` +
                        `1) ${primaryLogoRelativePath}\n` +
                        `2) ${fallbackLogoRelativePath}`;
                    console.error(chalk.red(errText));
                    throw new Error(errText);
                }
            }

            const tempDir = path.join(__dirname, 'tmp');
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            const slug = appNameSlug || branchName;
            const safeSlug = String(slug).replace(/[^a-zA-Z0-9._-]/g, '_');
            const safeBranchFile = String(branchName || 'branch').replace(/[^a-zA-Z0-9._-]/g, '_');
            // 必须带分支名：同 slug 多分支并发或「准备后因去重跳过」时避免互相覆盖与残留孤儿文件
            const pngName = `${safeBranchFile}-${safeSlug}.png`;
            const pngPath = path.join(tempDir, pngName);

            console.log(chalk.cyan(`🖼 正在将 gulu_top.avif 转为 PNG（命名为 ${pngName}）...`));
            // Windows 下直接 sharp(logoPath) 偶发会导致源文件句柄占用，后续 git checkout 无法 unlink
            // 这里改为先读入内存再处理，避免长时间持有 repo 内 avif 文件句柄
            const logoBuffer = fs.readFileSync(logoPath);
            await sharp(logoBuffer).png().toFile(pngPath);
            console.log(chalk.green(`🖼 PNG Logo 生成完成: ${pngPath}`));

            const logoKey = pngName;
            try {
                logoInfo = await uploadFileToS3(pngPath, logoKey, 'image/png');
                console.log(chalk.green('📤 Logo 已上传到 S3'));
                logoLocalPath = pngPath;
            } catch (e) {
                if (fs.existsSync(pngPath)) {
                    try {
                        fs.unlinkSync(pngPath);
                    } catch {
                        // 忽略
                    }
                }
                console.log(chalk.yellow('上传 Logo 到 S3 失败:', e.message));
                throw new Error(`Logo 上传到 S3 失败: ${e && e.message ? e.message : String(e)}`);
            }
        } catch (e) {
            console.log(chalk.yellow('处理 Logo 时发生错误:', e.message));
            // Logo 相关任何错误都视为本次打包失败
            throw e;
        }

        return {
            appName,
            appNameSlug,
            primaryDomain,
            packageId,
            logoInfo,
            logoLocalPath,
            logoSourceType,
            projectName: project.name,
        };
    }

    // 打包阶段：调用打包接口、轮询 list、下载 APK、上传 S3 并通知群聊
    async function runApkPackaging({
        appName,
        appNameSlug,
        primaryDomain,
        logoInfo,
        logoLocalPath,
        logoSourceType,
        branchName,
        chatId,
        projectName,
        statusMsgId,
    }) {
        if (!appNameSlug) {
            throw new Error('未能从配置中解析出 app_name（appDownPath 中 app- 和 .apk 之间的部分）');
        }

        if (!primaryDomain) {
            throw new Error('未能从配置中解析出 proxyShareUrlList 域名，无法生成 web_url');
        }

        const webUrlDomain = primaryDomain.replace(/\/+$/, '');
        const webUrl = `${webUrlDomain}?isapk=1`;

        let imageUrl = (logoInfo && logoInfo.url) ? logoInfo.url : '';
        if (!imageUrl) {
            console.log(chalk.yellow(`⚠ Logo 未成功上传到 S3（分支: ${branchName}），将使用空 image_url 调用打包接口`));
        }

        const triggerTimeMs = Date.now();

        await callPackApi(appNameSlug, webUrl, imageUrl);

        const packed = await waitForPackedApk(appNameSlug, triggerTimeMs, 10, 60000, chatId, statusMsgId, branchName);

        const tempDir = path.join(__dirname, 'tmp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const apkFileNameFromServer = packed.name;
        const safeBranch = String(branchName || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
        const localApkPath = path.join(
            tempDir,
            `${Date.now()}-${safeBranch}-${apkFileNameFromServer}`,
        );

        const downloadUrl = `http://47.128.239.172:8000${packed.url}`;
        console.log(chalk.cyan(`📥 开始下载打包好的 APK: ${downloadUrl}`));
        userBotLog.append('DOWNLOAD', `整段限时开始 ${branchName} -> ${apkFileNameFromServer}`);

        try {
            await withTimeout(
                downloadFileWithRetry(downloadUrl, localApkPath, 12, 15000),
                APK_DOWNLOAD_TOTAL_TIMEOUT_MS,
                `下载 APK ${branchName}`,
            );
        } catch (dlErr) {
            userBotLog.append(
                'DOWNLOAD',
                `整段失败/超时 ${branchName}: ${(dlErr && dlErr.message) || dlErr}`,
            );
            try {
                if (fs.existsSync(localApkPath)) {
                    fs.unlinkSync(localApkPath);
                }
            } catch {
                // 忽略
            }
            throw dlErr;
        }

        const s3Key = appName || apkFileNameFromServer;

        let url;
        try {
            const result = await uploadFileToS3(
                localApkPath,
                s3Key,
                'application/vnd.android.package-archive',
                120000,
            );
            url = result && result.url;
        } catch (error) {
            userBotLog.append(
                'APK',
                `上传 APK 到 S3 失败 ${projectName}/${branchName}: ${(error && error.message) || error}`,
            );
            try {
                if (fs.existsSync(localApkPath)) {
                    fs.unlinkSync(localApkPath);
                }
            } catch {
                // 忽略
            }
            throw error;
        }

        const apkUrl = url;

        let msg =
            `✅ APK 打包完成 | ${branchName}\n` +
            `APK地址: ${apkUrl}`;
        if (logoSourceType === 'fallback') {
            const fallbackWarn =
                '⚠ 提醒: 第一位置未找到 Logo，当前分支使用了备用路径 src/assets/img/configFile/gulu_top.avif，请核对。';
            msg += `\n${fallbackWarn}`;
            userBotLog.append('APK', `${branchName} ${fallbackWarn}`);
        }

        try {
            userBotLog.append('APK', `Telegram 发群开始 ${branchName}`);
            let sentWithLogo = false;
            if (logoLocalPath && fs.existsSync(logoLocalPath)) {
                await withTimeout(
                    client.sendFile(chatId, {
                        file: logoLocalPath,
                        caption: msg,
                        forceDocument: true,
                    }),
                    TELEGRAM_SEND_FILE_TIMEOUT_MS,
                    `Telegram sendFile(Logo) 分支 ${branchName}`,
                );
                sentWithLogo = true;
            } else if (logoInfo && logoInfo.url) {
                // 本地 PNG 已被删或并发冲突时，用已上传 S3 的 Logo 拉取后再发，避免只有文字
                try {
                    const res = await axios.get(logoInfo.url, {
                        responseType: 'arraybuffer',
                        timeout: 60000,
                        validateStatus: (s) => s >= 200 && s < 400,
                    });
                    const buf = Buffer.from(res.data);
                    const tmpSendPath = path.join(
                        tempDir,
                        `logo-send-${String(branchName).replace(/[^a-zA-Z0-9._-]/g, '_')}-${Date.now()}.png`,
                    );
                    fs.writeFileSync(tmpSendPath, buf);
                    try {
                        await withTimeout(
                            client.sendFile(chatId, {
                                file: tmpSendPath,
                                caption: msg,
                                forceDocument: true,
                            }),
                            TELEGRAM_SEND_FILE_TIMEOUT_MS,
                            `Telegram sendFile(Logo缓存) 分支 ${branchName}`,
                        );
                        sentWithLogo = true;
                    } finally {
                        try {
                            if (fs.existsSync(tmpSendPath)) fs.unlinkSync(tmpSendPath);
                        } catch {
                            // 忽略
                        }
                    }
                } catch (fetchErr) {
                    console.log(
                        chalk.yellow(
                            `从 S3 拉取 Logo 用于回传失败（将仅发文字）: ${(fetchErr && fetchErr.message) || fetchErr}`,
                        ),
                    );
                }
            } else {
                console.log(
                    chalk.yellow(
                        `无可用本地 Logo 且无 logoInfo.url，仅发送文字完成通知（分支 ${branchName}）`,
                    ),
                );
            }
            if (!sentWithLogo) {
                await withTimeout(
                    client.sendMessage(chatId, { message: msg, linkPreview: false }),
                    TELEGRAM_SEND_MESSAGE_TIMEOUT_MS,
                    `Telegram sendMessage 分支 ${branchName}`,
                );
            }
            try {
                apkTracker.remove(branchName);
                console.log(chalk.gray(`已从 apk-pending.json 移除已完成分支: ${branchName}`));
            } catch (rmErr) {
                console.log(chalk.yellow('更新 apk-pending.json 失败（可忽略）:', rmErr.message));
            }
            userBotLog.append('APK', `Telegram 发群完成 ${branchName}`);
            try {
                apkBuiltHistory.recordBuilt(projectName, appNameSlug, {
                    branchName,
                    s3Url: apkUrl,
                });
            } catch (histErr) {
                console.log(chalk.yellow('写入 apk-built-history 失败（可忽略）:', histErr.message));
            }
        } catch (e) {
            const errMsg = (e && e.message) || String(e);
            console.log(chalk.yellow('发送 APK 结果消息失败:', errMsg));
            userBotLog.append('APK', `Telegram 通知失败 ${branchName}: ${errMsg}`);
            throw e;
        } finally {
            try {
                if (fs.existsSync(localApkPath)) {
                    fs.unlinkSync(localApkPath);
                }
                if (logoLocalPath && fs.existsSync(logoLocalPath)) {
                    fs.unlinkSync(logoLocalPath);
                    console.log(chalk.gray('🧹 已删除临时 PNG Logo 文件'));
                }
            } catch {
                // 忽略
            }
        }
    }

    // 解析「打包APK」多分支列表（单条命令内去重实际分支名）
    async function resolveApkBatchTargets(branchNames) {
        const resolvedTargets = [];
        const invalidBranches = [];
        const seenBranch = new Set();

        for (const rawName of branchNames) {
            const name = (rawName || '').trim();
            if (!name) continue;
            try {
                const resolved = await resolveProjectAndBranch(name);
                if (resolved) {
                    const bn = resolved.actualBranchName;
                    if (seenBranch.has(bn)) continue;
                    seenBranch.add(bn);
                    resolvedTargets.push({
                        inputName: name,
                        project: resolved.project,
                        branchName: bn,
                    });
                } else {
                    invalidBranches.push(name);
                }
            } catch (e) {
                console.log(chalk.yellow(`在所有项目中解析分支 ${name} 失败: ${e.message}`));
                invalidBranches.push(name);
            }
        }
        return { resolvedTargets, invalidBranches };
    }

    /** 批量中单条：失败后重新 prepare 再跑一轮 runApkPackaging（仅自动重试 1 次） */
    async function runBatchApkOneBranchWithRetry(ctx, sessionChatId) {
        const run = async (c) => {
            await runApkPackaging(c);
        };
        try {
            await run(ctx);
            return;
        } catch (firstErr) {
            const msg0 = (firstErr && firstErr.message) || String(firstErr);
            console.log(
                chalk.yellow(`[批量] 分支 ${ctx.branchName} 首次失败，将重试 1 次: ${msg0}`),
            );
            userBotLog.append('APK', `[批量自动重试] ${ctx.branchName}: ${msg0}`);
            const delayMs = parseInt(process.env.APK_BATCH_RETRY_DELAY_MS || '3000', 10);
            if (Number.isFinite(delayMs) && delayMs > 0) {
                await new Promise((r) => setTimeout(r, delayMs));
            }
            let ctxNext = ctx;
            try {
                const resolved = await resolveProjectAndBranch(ctx.branchName);
                if (resolved) {
                    const fresh = await prepareApkContext(resolved.project, ctx.branchName, null);
                    ctxNext = {
                        ...fresh,
                        branchName: ctx.branchName,
                        chatId: sessionChatId,
                    };
                }
            } catch (reprepErr) {
                console.log(
                    chalk.yellow(
                        `[批量] 重试前重新准备上下文失败，沿用原上下文再试: ${reprepErr.message}`,
                    ),
                );
            }
            await run(ctxNext);
        }
    }

    function buildApkBatchSummaryText(orderedBranches, outcomes) {
        const successList = orderedBranches.filter(b => outcomes.get(b) === 'success');
        const skippedList = orderedBranches.filter(b => outcomes.get(b) === 'skipped');
        const failureList = orderedBranches.filter(
            b => outcomes.get(b) !== 'success' && outcomes.get(b) !== 'skipped',
        );

        const successCount = successList.length;
        const failureCount = failureList.length;
        const skippedCount = skippedList.length;

        let summaryMsg = `📊 APK 批量打包统计\n\n✅ 成功 ${successCount} 条`;
        if (successList.length) {
            summaryMsg += '\n' + successList.map((b, i) => `${i + 1}. ${b}`).join('\n');
        }
        summaryMsg += `\n\n⏭ 跳过（曾成功打包） ${skippedCount} 条`;
        if (skippedList.length) {
            summaryMsg += '\n' + skippedList.map((b, i) => `${i + 1}. ${b}`).join('\n');
        }
        summaryMsg += `\n\n❌ 失败 ${failureCount} 条`;
        if (failureList.length) {
            summaryMsg += '\n' + failureList.map((b, i) => `${i + 1}. ${b}`).join('\n');
        }
        return summaryMsg;
    }

    async function refreshApkBatchSummaryIfBranchRecovered(chatId, branchName) {
        const ref = apkBatchEditableSummaryRef;
        if (!ref || ref.messageId == null || branchName == null || chatId == null) {
            return;
        }
        if (String(ref.chatId) !== String(chatId)) {
            return;
        }
        if (!ref.orderedBranches.includes(branchName)) {
            return;
        }
        const prev = ref.outcomes.get(branchName);
        if (prev === 'success' || prev === 'skipped') {
            return;
        }
        ref.outcomes.set(branchName, 'success');
        const summaryMsg = buildApkBatchSummaryText(ref.orderedBranches, ref.outcomes);
        try {
            await withTimeout(
                client.editMessage(ref.chatId, {
                    id: ref.messageId,
                    message: summaryMsg,
                    linkPreview: false,
                }),
                TELEGRAM_SEND_MESSAGE_TIMEOUT_MS,
                'Telegram editMessage(批量汇总回填)',
            );
            userBotLog.append(
                'APK',
                `批量统计已回填 ${branchName} → 成功 messageId=${ref.messageId}`,
            );
        } catch (e) {
            console.log(chalk.yellow('回填批量汇总消息失败（仍可忽略）:', e.message || e));
        }
    }

    async function runApkBatchWorkerLoop() {
        const outcomes = new Map();
        const orderedBranches = [];
        let sessionChatId = null;
        let batchHadAutoDedup = false;

        try {
            while (apkBatchChunkQueue.length > 0) {
                const chunks = [];
                while (apkBatchChunkQueue.length > 0) {
                    chunks.push(apkBatchChunkQueue.shift());
                }

                const newTargets = [];
                let sessionApplyApkDedup = false;
                for (const chunk of chunks) {
                    if (sessionChatId == null) {
                        sessionChatId = chunk.chatId;
                    } else if (String(chunk.chatId) !== String(sessionChatId)) {
                        console.log(
                            chalk.yellow(
                                '批量合并：已忽略与当前会话不同 chatId 的块（仅合并同一群内的打包APK）',
                            ),
                        );
                        continue;
                    }
                    if (chunk.applyApkBuiltDedup) {
                        sessionApplyApkDedup = true;
                        batchHadAutoDedup = true;
                    }
                    for (const t of chunk.resolvedTargets) {
                        const bn = t.branchName;
                        if (!orderedBranches.includes(bn)) {
                            orderedBranches.push(bn);
                            newTargets.push(t);
                            continue;
                        }
                        const prev = outcomes.get(bn);
                        if (prev === 'success') {
                            continue;
                        }
                        if (prev === 'failure') {
                            newTargets.push(t);
                            continue;
                        }
                        // 已在会话中但尚无 outcome（例如仍在并发执行）：不重复入队
                    }
                }

                if (newTargets.length === 0) {
                    continue;
                }

                const contexts = [];
                for (const target of newTargets) {
                    const { project, branchName } = target;
                    try {
                        const ctx = await prepareApkContext(project, branchName, null);
                        if (
                            sessionApplyApkDedup &&
                            apkBuiltHistory.wasAlreadyBuilt(ctx.projectName, ctx.appNameSlug)
                        ) {
                            // 批量模式下仅在最终汇总中统计「跳过」，不逐条发送提示消息
                            outcomes.set(branchName, 'skipped');
                            // 已确认历史成功的分支不应继续留在待打包列表中
                            try {
                                apkTracker.remove(branchName);
                            } catch (rmErr) {
                                console.log(chalk.yellow('批量去重后移除 apk-pending 失败（可忽略）:', rmErr.message));
                            }
                            tryUnlinkIfExists(ctx.logoLocalPath);
                            continue;
                        }
                        contexts.push({
                            ...ctx,
                            branchName,
                            chatId: sessionChatId,
                        });
                    } catch (e) {
                        console.error(chalk.red(`为分支 ${branchName} 准备打包上下文失败:`), e);
                        outcomes.set(branchName, 'failure');
                        userBotLog.append(
                            'APK',
                            `批量准备环境失败（不向群逐条发送，见最终汇总） ${branchName}: ${(e && e.message) || e}`,
                        );
                    }
                }

                if (contexts.length === 0) {
                    continue;
                }

                // 默认 2：同一 GramJS 客户端并发多路 sendFile 易触发 updates TIMEOUT 与整批卡死
                const rawConc = parseInt(process.env.APK_MAX_CONCURRENCY || '2', 10);
                const maxConcurrency =
                    Number.isFinite(rawConc) && rawConc > 0 ? Math.min(rawConc, 20) : 2;
                const queue = contexts.slice();
                let running = 0;

                await new Promise((resolve) => {
                    const runNext = () => {
                        if (queue.length === 0 && running === 0) {
                            resolve();
                            return;
                        }
                        while (queue.length > 0 && running < maxConcurrency) {
                            const ctx = queue.shift();
                            running++;
                            (async () => {
                                try {
                                    await withTimeout(
                                        runBatchApkOneBranchWithRetry(ctx, sessionChatId),
                                        APK_BRANCH_TOTAL_TIMEOUT_MS,
                                        `分支 ${ctx.branchName} APK 整链`,
                                    );
                                    outcomes.set(ctx.branchName, 'success');
                                } catch (e) {
                                    userBotLog.append(
                                        'APK',
                                        `批量任务失败（含 1 次自动重试） ${ctx.projectName}/${ctx.branchName}: ${(e && e.message) || e}`,
                                    );
                                    console.log(
                                        chalk.red(
                                            `❌ 批量 APK 失败 ${ctx.projectName}/${ctx.branchName}（详情见日志）`,
                                        ),
                                    );
                                    outcomes.set(ctx.branchName, 'failure');
                                    userBotLog.append(
                                        'APK',
                                        `批量 APK 失败（不向群逐条发送，见最终汇总） ${ctx.projectName}/${ctx.branchName}: ${(e && e.message) || e}`,
                                    );
                                } finally {
                                    running--;
                                    runNext();
                                }
                            })();
                        }
                    };

                    runNext();
                });
            }

            if (orderedBranches.length === 0 || sessionChatId == null) {
                return;
            }

            const summaryMsg = buildApkBatchSummaryText(orderedBranches, outcomes);

            apkBatchEditableSummaryRef = {
                chatId: sessionChatId,
                messageId: null,
                orderedBranches: orderedBranches.slice(),
                outcomes: new Map(outcomes),
            };

            try {
                const sent = await withTimeout(
                    client.sendMessage(sessionChatId, { message: summaryMsg, linkPreview: false }),
                    TELEGRAM_SEND_MESSAGE_TIMEOUT_MS,
                    'Telegram sendMessage(批量汇总)',
                );
                if (
                    apkBatchEditableSummaryRef &&
                    sent &&
                    sent.id != null &&
                    String(apkBatchEditableSummaryRef.chatId) === String(sessionChatId)
                ) {
                    apkBatchEditableSummaryRef.messageId = sent.id;
                }
            } catch (e) {
                apkBatchEditableSummaryRef = null;
                console.log(chalk.yellow('发送批量汇总统计失败:', e.message || e));
            }

            if (batchHadAutoDedup && orderedBranches.length > 0) {
                for (const b of orderedBranches) {
                    try {
                        apkTracker.remove(b);
                    } catch (rmErr) {
                        console.log(chalk.yellow(`批量结束后移除 pending「${b}」失败（可忽略）:`, rmErr.message));
                    }
                }
                console.log(chalk.gray('自动/去重批量 APK 已完成，已从 apk-pending 移除本批全部分支'));
            }
        } finally {
            apkBatchWorkerPromise = null;
        }
    }

    // 批量打包：多个分支；未发汇总前再次触发「打包APK 多分支」会并入同一会话，只发一条 📊
    async function handleBatchApkBuild(branchNames, chatId, applyApkBuiltDedup = false) {
        const { resolvedTargets, invalidBranches } = await resolveApkBatchTargets(branchNames);

        if (invalidBranches.length > 0) {
            console.log(
                chalk.yellow(
                    `⚠ 以下分支在两个仓库中都未找到，将跳过: ${invalidBranches.join(', ')}`,
                ),
            );
        }

        if (resolvedTargets.length === 0) {
            console.log(chalk.red('❌ 批量打包中没有任何有效分支，直接返回'));
            try {
                await client.sendMessage(chatId, {
                    message:
                        `❌ 批量打包未开始：下列分支在 WG-WEB / WGAME-WEB 中均未解析到有效分支。\n\n` +
                        branchNames.join(', '),
                    linkPreview: false,
                });
            } catch (e) {
                console.log(chalk.yellow('发送「无有效分支」提示失败:', e.message || e));
            }
            return;
        }

        apkBatchChunkQueue.push({ resolvedTargets, chatId, applyApkBuiltDedup });

        if (!apkBatchWorkerPromise) {
            apkBatchWorkerPromise = runApkBatchWorkerLoop();
        }

        await apkBatchWorkerPromise;
    }

    // 处理按钮 / 文本命令触发的 APK 打包 + 上传到 S3（单分支入口）
    async function handleBuildApkForBranch(
        project,
        branchName,
        chatId,
        { packageId, appName, appNameSlug, primaryDomain, statusMsgId, applyApkBuiltDedup = false },
    ) {
        console.log(chalk.cyan(`\n🚀 开始为项目 ${project.name} 的分支 ${branchName} 打包 APK`));

        try {
            const ctx = await prepareApkContext(project, branchName, packageId);

            // 允许外部预先传入的 appName / appNameSlug / primaryDomain 覆盖配置结果（目前一般不需要）
            const merged = {
                appName: appName || ctx.appName,
                appNameSlug: appNameSlug || ctx.appNameSlug,
                primaryDomain: primaryDomain || ctx.primaryDomain,
                logoInfo: ctx.logoInfo,
                logoLocalPath: ctx.logoLocalPath,
                logoSourceType: ctx.logoSourceType,
                branchName,
                chatId,
                projectName: ctx.projectName,
                statusMsgId,
            };

            if (
                applyApkBuiltDedup &&
                apkBuiltHistory.wasAlreadyBuilt(merged.projectName, merged.appNameSlug)
            ) {
                const slug = String(merged.appNameSlug || '').toLowerCase();
                try {
                    await withTimeout(
                        client.sendMessage(chatId, {
                            message:
                                `ℹ️ 该 APK 已成功打包过，本次跳过（自动任务去重）\n\n` +
                                `📁 项目: ${merged.projectName}\n` +
                                `🌿 分支: ${branchName}\n` +
                                `📱 目标包: app-${slug}.apk`,
                            linkPreview: false,
                        }),
                        TELEGRAM_SEND_MESSAGE_TIMEOUT_MS,
                        `Telegram sendMessage(APK 已打包跳过) ${branchName}`,
                    );
                } catch (skipSendErr) {
                    console.log(chalk.yellow('发送「APK 已打包跳过」失败:', skipSendErr.message));
                }
                // 单分支去重命中时也同步清理待打包列表，避免 /apk_list 长期堆积
                try {
                    apkTracker.remove(branchName);
                } catch (rmErr) {
                    console.log(chalk.yellow('单分支去重后移除 apk-pending 失败（可忽略）:', rmErr.message));
                }
                tryUnlinkIfExists(merged.logoLocalPath);
                return;
            }

            await runApkPackaging(merged);
            await refreshApkBatchSummaryIfBranchRecovered(chatId, branchName);
        } catch (error) {
            const safeProjectName = project && project.name ? project.name : '未知项目';
            userBotLog.append(
                'APK',
                `失败 ${safeProjectName}/${branchName}: ${(error && error.message) || error}`,
            );
            console.log(chalk.red(`❌ APK 打包失败 ${safeProjectName}/${branchName}（详情见日志）`));

            if (!shouldSuppressTelegramForApkPrepGitError(error)) {
                try {
                    await withTimeout(
                        client.sendMessage(chatId, {
                            message: buildApkFailureTelegramMessage(safeProjectName, branchName, error),
                            linkPreview: false,
                        }),
                        TELEGRAM_SEND_MESSAGE_TIMEOUT_MS,
                        `Telegram sendMessage(单分支失败) ${branchName}`,
                    );
                } catch (e) {
                    console.log(chalk.yellow('发送 APK 失败结果消息失败:', e.message));
                }
            }

            throw error;
        }
    }

    // 上传 ZIP 到 Telegram 的任务队列
    const uploadQueue = [];
    let isUploading = false;

    async function processUploadQueue() {
        if (isUploading) return;
        isUploading = true;

        while (uploadQueue.length > 0) {
            const task = uploadQueue.shift();
            const { project, branchName, chatId, result } = task;
            const log = (...args) => console.log(chalk.blue(`[${branchName}]`), ...args);

            if (!result || !result.success || !result.zipFilePath) {
                log(chalk.yellow('跳过上传：构建结果无效或缺少 zip 文件路径'));
                continue;
            }

            // 上传 ZIP 到 Telegram，增加简单重试以应对短暂断线（Not connected / connection closed 等）
            let uploadSuccess = false;
            const maxUploadAttempts = 3;
            const uploadDelayMs = 3000;

            log('构建完成，开始上传...');

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

            // 构建完成后，根据配置决定是否执行自动压缩包分析
            if (!ENABLE_ZIP_ANALYZE) {
                if (result && result.zipFilePath && fs.existsSync(result.zipFilePath)) {
                    fs.unlinkSync(result.zipFilePath);
                    log('已清理临时文件');
                }
                continue;
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

                    if (shouldQueueFileAnalyzeForProject(project)) {
                        fileProcessQueue.push(fileTask);
                    } else {
                        await processFileTask(fileTask);
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
        }

        isUploading = false;
    }

    function enqueueUploadTask(project, branchName, chatId, result) {
        uploadQueue.push({ project, branchName, chatId, result });
        // 异步处理上传队列，不阻塞构建队列
        processUploadQueue().catch((err) => {
            console.error(chalk.red('处理上传队列时出错:'), err);
        });
    }

    async function sendConfigScreenshotsToChat(project, branchName, chatId) {
        let pngPath = null;
        try {
            pngPath = await renderConfigScreenshots(project.path, {
                projectLabel: project.name,
                branchName,
            });
            if (!pngPath) return;

            await withTimeout(
                client.sendFile(chatId, {
                    file: pngPath,
                    forceDocument: false,
                }),
                TELEGRAM_SEND_FILE_TIMEOUT_MS,
                `Telegram sendFile(配置截图) ${branchName}`,
            );
        } catch (err) {
            console.log(
                chalk.yellow(`[${branchName}] 配置截图生成/发送失败（可忽略）: ${(err && err.message) || err}`),
            );
        } finally {
            tryUnlinkPngs(pngPath);
        }
    }

    async function handleAfterCheckoutForBuild(project, branchName, chatId, packageIdTarget) {
        if (packageIdTarget != null) {
            const syncResult = await syncPackageIdWithGit(project.builder, packageIdTarget);
            if (syncResult.ok && syncResult.skipped) {
                console.log(chalk.gray(`[${branchName}] packageId 已是 ${packageIdTarget}，跳过提交`));
            } else if (syncResult.ok) {
                console.log(
                    chalk.green(`[${branchName}] 分包已同步并推送: packageId=${packageIdTarget}`),
                );
            } else {
                await project.builder.runCommand('git checkout -- src/config/config.js');
                const errMsg = syncResult.error || '未知错误';
                console.log(chalk.red(`[${branchName}] 分包同步失败，已中止本分支打包: ${errMsg}`));
                throw new Error(`分包同步失败: ${errMsg}`);
            }
        }

        await sendConfigScreenshotsToChat(project, branchName, chatId);
    }

    // 执行构建流程（可复用函数，使用指定 project 的 builder）
    async function executeBuild(project, branchName, senderId, chatId, buildOptions = {}) {
        shouldCancelBuild = false;
        const buildRunner = project && project.builder ? project.builder : builder;
        const packageIdTarget =
            buildOptions.packageId != null && Number.isFinite(buildOptions.packageId)
                ? buildOptions.packageId
                : null;

        const log = (...args) => console.log(chalk.blue(`[${branchName}]`), ...args);

        const updateProgress = async (stage, percent, msg) => {
            if (shouldCancelBuild) return;
            const text = msg || stage || '';
            if (percent === 100 || percent % 20 === 0) {
                log(`${percent}%`, text);
            }
        };

        const fullBuildOptions = {
            afterCheckout: async () => {
                await handleAfterCheckoutForBuild(project, branchName, chatId, packageIdTarget);
            },
        };

        const result = await enqueueProjectGitWork(project.name, () =>
            buildRunner.fullBuild(branchName, updateProgress, fullBuildOptions),
        );

        // 将本次 zip 构建结果写入日志，便于排查「分支 ↔ zip」是否错位
        try {
            if (result && result.success) {
                const zipName = result.zipFileName || '<no-zip-name>';
                const zipPath = result.zipFilePath || '<no-zip-path>';
                userBotLog.append(
                    'ZIP',
                    `build_success ${project && project.name ? project.name : 'UNKNOWN'}/${branchName} -> ${zipName} (${zipPath})`,
                );
            } else {
                userBotLog.append(
                    'ZIP',
                    `build_failure ${project && project.name ? project.name : 'UNKNOWN'}/${branchName}: ${
                        (result && result.error) || 'unknown_error'
                    }`,
                );
            }
        } catch {
            // 日志失败不影响主流程
        }

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

        // 构建成功后，将上传任务加入上传队列，立即返回让下一个构建继续
        enqueueUploadTask(project, branchName, chatId, result);

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
        currentBuildProjectName = nextTask.project && nextTask.project.name ? nextTask.project.name : '';
        currentBuildId = nextTask.buildId;

        // 开始构建流程（不单独发消息，直接开始）
        try {
            await executeBuild(nextTask.project, nextTask.branchName, nextTask.userId, nextTask.chatId, {
                packageId: nextTask.packageId,
            });
        } catch (error) {
            console.error(chalk.red('队列任务处理失败:'), error);
        }

        // 重置状态
        isBuilding = false;
        currentBuildBranch = '';
        currentBuildProjectName = '';
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

// 全局错误兜底：避免单次任务异常导致整个服务退出
process.on('unhandledRejection', (reason, promise) => {
    console.error(chalk.red('未处理的 Promise 拒绝:'), reason);
});

process.on('uncaughtException', (err) => {
    console.error(chalk.red('未捕获的异常:'), err);
});

