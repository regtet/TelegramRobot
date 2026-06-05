const { TelegramClient, LogLevel } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const input = require('input');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const axios = require('axios');
const paths = require('./lib/paths');
paths.migrateLegacyLayout();
const dotenv = require('dotenv');
const apkTracker = require('./lib/apk/apk-tracker');
const apkBuiltHistory = require('./lib/apk/apk-built-history');
const branchPackageExpect = require('./lib/branch/branch-package-expect');
const branchAnnounceState = require('./lib/branch/branch-announce-state');
const branchGroupParse = require('./lib/branch/branch-group-auto-parse');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const { spawn } = require('child_process');

// 显式加载 .env，确保 AWS_* 等环境变量可用
dotenv.config({ path: paths.envFile });

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
const { parseEnvBool } = require('./lib/core/env-bool');
const { BranchTunnelManager } = require('./lib/dev/branch-tunnel');
const userBotLog = require('./lib/logging/user-bot-logger');
const apkPendingAdmin = require('./lib/apk/apk-pending-admin');
const {
    extractBranchFromApkMessage,
    isApkSuccessDoneMessage,
    getUniquePendingBranches,
    parseApkSlashCommand,
    APK_HELP_TEXT,
} = apkPendingAdmin;

// 是否启用“收到群消息自动打开 LX Music”功能
// 需要时把这个改成 true，不需要时改回 false
// const ENABLE_LX_MUSIC_ON_MESSAGE = true;
const ENABLE_LX_MUSIC_ON_MESSAGE = false;

// LX Music 桌面版路径（请确保路径存在）
const LX_MUSIC_PATH = 'D:\\Music\\lx-music-desktop\\lx-music-desktop.exe';

// 是否打印 Telegram MTProto 底层网络重连/超时等详细日志（默认 false，避免刷屏）
const ENABLE_TELEGRAM_NETWORK_LOG = false;

const ENABLE_ZIP_ANALYZE = parseEnvBool('ENABLE_ZIP_ANALYZE', true);
const ENABLE_ZIP_PENDING = parseEnvBool('ENABLE_ZIP_PENDING', true);
const ENABLE_MANUAL_DETECT = parseEnvBool('ENABLE_MANUAL_DETECT', false);
const ENABLE_BUILD_ZIP_ANALYZE = parseEnvBool('ENABLE_BUILD_ZIP_ANALYZE', false);
const ENABLE_AUTO_BRANCHLIST_FROM_GROUP = parseEnvBool('ENABLE_AUTO_BRANCHLIST_FROM_GROUP', true);
const ENABLE_LOG_ALL_MESSAGES = parseEnvBool('ENABLE_LOG_ALL_MESSAGES', false);
const ENABLE_APK_CRON = parseEnvBool('ENABLE_APK_CRON', true);
const ENABLE_TUNNEL_ALL_USERS = parseEnvBool('ENABLE_TUNNEL_ALL_USERS', false);
const DEV_TUNNEL_PORT = parseInt(process.env.DEV_TUNNEL_PORT || '8088', 10);
const DEV_TUNNEL_DURATION_MS = parseInt(
    process.env.DEV_TUNNEL_DURATION_MS || String(10 * 60 * 1000),
    10,
);

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
/** @type {import('./lib/dev/branch-tunnel').BranchTunnelManager | null} */
let branchTunnelManager = null;

// Session 文件（data/session.txt）
const sessionFile = paths.sessionFile;
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
    ? path.resolve(paths.ROOT, process.env.BUILD_PROJECT_PATH_B)
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
/** 递增后使进行中的「打包」指令失效（含分支验证阶段） */
let buildAbortToken = 0;
let isPackPreparing = false; // 分支验证 / 入队准备阶段

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
/** 当前正在执行的压缩包检测任务（用于 Git 清理时保留占用分支） */
let currentFileProcessTask = null;

/**
 * 「打包」流程：checkout 后预收集检测文案 + 配置截图，等 zip 上传完成后再一并发送（避免多次拉代码）
 * key: `${chatId}:${branchLower}`
 */
const pendingZipBuildBundles = new Map();
const ZIP_BUILD_BUNDLE_TTL_MS = parseInt(
    process.env.ZIP_BUILD_BUNDLE_TTL_MS || String(60 * 60 * 1000),
    10,
);

function makeZipBuildBundleKey(chatId, branchName) {
    return `${String(chatId)}:${(branchName || '').trim().toLowerCase()}`;
}

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
                `✓ 仅处理以下会话的消息: ${Array.from(allowedChatIds).join(', ')}`,
            ),
        );
        for (const id of allowedChatIds) {
            const n = Number(id);
            if (Number.isFinite(n) && n > 0) {
                console.log(
                    chalk.yellow(
                        `⚠ CHAT_ID/CHAT_IDS 中的 ${id} 看起来像用户私聊 ID；工作群一般为负数（如 -100xxxxxxxx）。与 Bot 私聊不会触发打包，除非把该私聊 ID 也写进配置。`,
                    ),
                );
            }
        }
    }

    console.log(chalk.gray('\n等待命令...\n'));
    console.log(chalk.gray(`详细运行日志目录: ${userBotLog.LOGS_DIR}（user-bot.log 等）\n`));
    userBotLog.initOnStartup();

    branchTunnelManager = new BranchTunnelManager({
        cloudflaredPath: (process.env.CLOUDFLARED_PATH || '').trim(),
        devPort: DEV_TUNNEL_PORT,
        durationMs: DEV_TUNNEL_DURATION_MS,
    });
    const branchTunnel = branchTunnelManager;

    function getPrimaryChatId() {
        if (chatId) return chatId;
        if (allowedChatIds.size > 0) {
            const first = Array.from(allowedChatIds)[0];
            try {
                return BigInt(first);
            } catch {
                return null;
            }
        }
        return null;
    }

    console.log(
        chalk.gray(
            '✓ 压缩包：上传即入 APK 等待队列 + 配置检测（手动「检测」与构建后检测默认关闭）',
        ),
    );

    if (ENABLE_LOG_ALL_MESSAGES) {
        console.log(
            chalk.yellow(
                '⚠ ENABLE_LOG_ALL_MESSAGES 已开启：终端将打印本账号全部收发消息（含 chatId），仅调试用',
            ),
        );
    }

    /** 调试：打印任意会话消息，便于复制 CHAT_ID / CHAT_IDS */
    async function logAllMessagesToTerminal(event) {
        const message = event.message;
        if (!message) return;

        const chatIdStr =
            message.chatId != null && typeof message.chatId.toString === 'function'
                ? message.chatId.toString()
                : '?';
        const senderId =
            message.senderId != null && typeof message.senderId.toString === 'function'
                ? message.senderId.toString()
                : '?';
        const direction = message.out ? '发出' : '收到';
        const text = String(message.text || message.message || '').trim();

        let chatTitle = '';
        let chatType = '';
        try {
            const chat = await message.getChat();
            if (chat) {
                chatType = chat.className || '';
                chatTitle =
                    chat.title || chat.username || [chat.firstName, chat.lastName].filter(Boolean).join(' ') || '';
            }
        } catch {
            /* 忽略 */
        }

        let mediaHint = '';
        if (message.media) {
            const cn = message.media.className || 'Media';
            if (cn === 'MessageMediaDocument') {
                const attrs = message.media.document?.attributes || [];
                const fn = attrs.find((a) => a.className === 'DocumentAttributeFilename');
                mediaHint = fn?.fileName ? `文件:${fn.fileName}` : '文件';
            } else if (cn === 'MessageMediaPhoto') {
                mediaHint = '图片';
            } else {
                mediaHint = cn.replace(/^MessageMedia/, '') || '媒体';
            }
        }

        const preview = text
            ? text.length > 300
                ? `${text.slice(0, 300)}…`
                : text
            : mediaHint || '(无文本)';

        console.log(chalk.magenta('──────── 全量消息（调试） ────────'));
        console.log(chalk.cyan(`  方向     : ${direction}`));
        console.log(chalk.yellow(`  chatId   : ${chatIdStr}`));
        if (chatType) console.log(chalk.gray(`  类型     : ${chatType}`));
        if (chatTitle) console.log(chalk.gray(`  会话名   : ${chatTitle}`));
        console.log(chalk.gray(`  发送者ID : ${senderId}`));
        console.log(chalk.gray(`  消息ID   : ${message.id != null ? message.id : '-'}`));
        console.log(chalk.white(`  内容     : ${preview}`));
        console.log(chalk.magenta('────────────────────────────────\n'));
    }

    if (ENABLE_LOG_ALL_MESSAGES) {
        client.addEventHandler(
            async (event) => {
                try {
                    await logAllMessagesToTerminal(event);
                } catch (e) {
                    console.log(chalk.gray('全量消息调试输出失败:', (e && e.message) || e));
                }
            },
            new NewMessage({ incoming: true, outgoing: true }),
        );
    }

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

    /** 删除群内触发指令消息（需本账号有删消息权限；失败仅打日志，不阻断主流程） */
    async function tryDeleteTriggerMessage(message, label = '触发') {
        if (!message || message.id == null || message.chatId == null) return;
        try {
            await client.deleteMessages(message.chatId, [message.id], { revoke: true });
            console.log(chalk.gray(`已删除${label}消息 id=${message.id}`));
        } catch (e) {
            console.log(chalk.yellow(`删除${label}消息失败: ${(e && e.message) || e}`));
        }
    }

    function isBuildAborted(abortToken) {
        if (shouldCancelBuild) return true;
        if (abortToken != null && abortToken !== buildAbortToken) return true;
        return false;
    }

    function requestStopAllBuilds() {
        buildAbortToken++;
        shouldCancelBuild = true;
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

    /** 该项目仓库是否正被 zip 打包 / 排队占用（与穿透互斥） */
    function isProjectZipPackBusy(projectName) {
        if (!projectName) return false;
        if (isBuilding && currentBuildProjectName === projectName) return true;
        return buildQueue.some((t) => t.project && t.project.name === projectName);
    }

    /** 穿透与打包/APK/压缩包检测共用同一 Git 工作区，同项目需互斥 */
    function isProjectGitWorkspaceBusy(projectName) {
        if (!projectName) return false;
        if (isProjectZipPackBusy(projectName)) return true;
        if (isApkBuilding && currentApkBuildProjectName === projectName) return true;
        if (apkBuildQueue.some((t) => t.projectName === projectName)) return true;
        if (
            isProcessingFile &&
            currentFileProcessTask &&
            currentFileProcessTask.project &&
            currentFileProcessTask.project.name === projectName
        ) {
            return true;
        }
        if (fileProcessQueue.some((t) => t.project && t.project.name === projectName)) {
            return true;
        }
        return false;
    }

    function isProjectTunnelActive(projectName) {
        return Boolean(
            branchTunnelManager && branchTunnelManager.isProjectBusy(projectName),
        );
    }

    function getProjectTunnelBranch(projectName) {
        return branchTunnelManager
            ? branchTunnelManager.getActiveBranch(projectName)
            : null;
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

    /** 压缩包配置检测（群内上传压缩包触发） */
    async function scheduleZipConfigAnalyzeFromBranch({
        branchName,
        fileName,
        chatId: taskChatId,
    }) {
        const branchFromFile = (branchName || '').trim();
        if (!branchFromFile) return;

        console.log(
            chalk.cyan(
                `🔍 [压缩包] 开始配置检测: ${fileName || branchFromFile} → ${branchFromFile}`,
            ),
        );

        let resolved;
        try {
            resolved = await resolveProjectAndBranch(branchFromFile);
        } catch (e) {
            console.log(
                chalk.yellow(`压缩包配置检测解析分支失败: ${branchFromFile} - ${e.message}`),
            );
            return;
        }

        if (!resolved) {
            console.log(
                chalk.red(
                    `❌ 压缩包配置检测：分支在 WG-WEB / WGAME-WEB 中均未找到: ${branchFromFile}`,
                ),
            );
            if (taskChatId != null) {
                try {
                    await client.sendMessage(taskChatId, {
                        message:
                            `❌ 压缩包配置检测失败\n🌿 分支：${branchFromFile}\n未在 WG-WEB / WGAME-WEB 中找到该分支`,
                        linkPreview: false,
                    });
                } catch (sendErr) {
                    console.log(chalk.yellow('发送压缩包检测失败提示失败:', sendErr.message));
                }
            }
            return;
        }

        const targetChatId =
            taskChatId != null
                ? typeof taskChatId === 'bigint'
                    ? taskChatId
                    : BigInt(String(taskChatId))
                : chatId;

        const fileTask = {
            fileName: fileName || `${branchFromFile}.zip`,
            branchName: branchFromFile,
            actualBranchName: resolved.actualBranchName,
            project: resolved.project,
            chatId: targetChatId,
            timestamp: new Date(),
        };

        if (shouldQueueFileAnalyzeForProject(resolved.project)) {
            fileProcessQueue.push(fileTask);
            console.log(
                chalk.gray(
                    `压缩包检测已排队: ${fileTask.fileName}（队列 ${fileProcessQueue.length}）`,
                ),
            );
            if (!isProcessingFile) {
                scheduleNextQueuedFileAnalyze(0);
            }
        } else {
            await processFileTask(fileTask);
        }
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
        if (!task) {
            if (branchGroupParse.isAnnounceRelatedText(trimmedText)) {
                console.log(
                    chalk.yellow(
                        `⚠ [公告] 识别到复刻台相关内容但解析失败（发送者 ${senderId || '-'}，会话 ${chatIdStr}）`,
                    ),
                );
            }
            return;
        }

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

    /** 一键打包 apk-pending 队列（原 Bot /apk_start_all，直接调用户号批量逻辑） */
    async function runApkStartAll(targetChatId, { applyApkBuiltDedup = false } = {}) {
        const uniqueBranches = getUniquePendingBranches();
        if (uniqueBranches.length === 0) {
            await client.sendMessage(targetChatId, {
                message: '📭 当前没有等待打包 APK 的分支',
                linkPreview: false,
            });
            return;
        }

        console.log(
            chalk.cyan(`一键启动 APK，共 ${uniqueBranches.length} 个分支，去重=${applyApkBuiltDedup}`),
        );

        await handleBatchApkBuild(uniqueBranches, targetChatId, applyApkBuiltDedup);
    }

    /** /apk_* 队列管理（原 Bot 私聊/群命令） */
    async function handleApkSlashCommands(message, rawText) {
        const parsed = parseApkSlashCommand(rawText);
        if (!parsed) return false;

        const { cmd, args } = parsed;
        const targetChatId = message.chatId;

        const reply = async (msg) => {
            await client.sendMessage(targetChatId, { message: msg, linkPreview: false });
        };

        if (cmd === '/apk_list') {
            const all = apkTracker.getAll();
            if (all.length === 0) {
                await reply('📭 当前没有等待打包 APK 的分支');
            } else {
                const lines = all.map((item, idx) => {
                    const src = item.source || 'auto';
                    return `${idx + 1}. ${item.branch} (${src})`;
                });
                await reply('📋 等待打包 APK 列表:\n\n' + lines.join('\n'));
            }
            return true;
        }

        if (cmd === '/apk_add') {
            if (args.length === 0) {
                await reply('❌ 用法: /apk_add 分支名1 分支名2 ...');
                return true;
            }
            const added = [];
            for (const b of args) {
                const branch = (b || '').trim();
                if (!branch) continue;
                apkTracker.addOrUpdate(branch, { source: 'manual', chatId: targetChatId });
                added.push(branch);
            }
            if (added.length === 0) {
                await reply('❌ 未解析到有效分支名');
            } else {
                await reply(`✅ 已添加/更新分支: ${added.join(', ')}`);
            }
            return true;
        }

        if (cmd === '/apk_del') {
            if (args.length === 0) {
                await reply('❌ 用法: /apk_del 分支名1 分支名2 ...');
                return true;
            }
            const deleted = [];
            for (const b of args) {
                const branch = (b || '').trim();
                if (!branch) continue;
                apkTracker.remove(branch);
                deleted.push(branch);
            }
            if (deleted.length === 0) {
                await reply('❌ 未解析到有效分支名');
            } else {
                await reply(`✅ 已删除分支: ${deleted.join(', ')}`);
            }
            return true;
        }

        if (cmd === '/apk_clear') {
            apkTracker.clear();
            await reply('🧹 已清空等待打包 APK 列表');
            return true;
        }

        if (cmd === '/apk_start_all') {
            await runApkStartAll(targetChatId, { applyApkBuiltDedup: false });
            return true;
        }

        return false;
    }

    let lastApkCronDay = null;
    const cronChatId = getPrimaryChatId();
    function isInApkAutoDirectWindow(now = new Date()) {
        // 4:00（含）到 5:00（不含）之间，收到压缩包直接触发 APK，不再先入 pending
        const hour = now.getHours();
        return hour === 4;
    }

    if (ENABLE_APK_CRON && cronChatId) {
        setInterval(() => {
            const now = new Date();
            const hour = now.getHours();
            const minute = now.getMinutes();
            const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            if (hour === 4 && minute === 0 && lastApkCronDay !== today) {
                lastApkCronDay = today;
                void (async () => {
                    try {
                        await client.sendMessage(cronChatId, {
                            message: '⏰ 凌晨 4 点自动触发：正在打包等待队列中的全部分支…',
                            linkPreview: false,
                        });
                        await runApkStartAll(cronChatId, { applyApkBuiltDedup: true });
                        console.log(chalk.cyan('已执行凌晨 4 点自动 apk_start_all'));
                    } catch (e) {
                        console.log(chalk.yellow('凌晨定时 APK 失败:', (e && e.message) || e));
                    }
                })();
            }
        }, 60 * 1000);
        console.log(chalk.gray('✓ 已启用凌晨 4 点自动打包 apk-pending 队列'));
    }

    // 监听新消息
    client.addEventHandler(async (event) => {
        try {
            const message = event.message;

            if (!message) return;

            const text = String(message.text || message.message || '').trim();
            if (!text) return;
            const senderId =
                message.senderId != null && typeof message.senderId.toString === 'function'
                    ? message.senderId.toString()
                    : '';
            const chatIdStr = message.chatId.toString();
            const cleanTextEarly = text.split('@')[0].trim();

            if (!shouldHandleUserbotMessage(message, allowedChatIds, selfUserId)) {
                if (
                    cleanTextEarly.startsWith('/apk') ||
                    cleanTextEarly === 'apk_start_all' ||
                    cleanTextEarly.startsWith('打包')
                ) {
                    const allowed = Array.from(allowedChatIds).join(', ') || '(未配置)';
                    console.log(
                        chalk.yellow(
                            `已忽略指令（当前会话 chatId=${chatIdStr} 不在 CHAT_ID/CHAT_IDS 中）: ${cleanTextEarly}`,
                        ),
                    );
                    console.log(chalk.gray(`  仅以下会话会执行: ${allowed}`));
                }
                return;
            }

            if (isApkSuccessDoneMessage(text)) {
                const doneBranch = extractBranchFromApkMessage(text);
                if (doneBranch) {
                    apkTracker.remove(doneBranch);
                    console.log(chalk.green('已从等待打包 APK 列表移除分支:'), doneBranch);
                }
                return;
            }

            const isSelfAnnounce =
                message.out &&
                selfUserId &&
                senderId === selfUserId &&
                branchGroupParse.isAnnounceRelatedText(text);
            console.log(
                chalk.gray(
                    message.out
                        ? isSelfAnnounce
                            ? '收到自己发出的公告/指令:'
                            : '收到自己发出的指令:'
                        : '收到目标群消息:',
                ),
            );
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

            const cleanText = text.split('@')[0].trim();

            if (cleanText === '/help') {
                await client.sendMessage(message.chatId, {
                    message: APK_HELP_TEXT,
                    linkPreview: false,
                });
                return;
            }

            if (cleanText === 'apk_start_all') {
                await runApkStartAll(message.chatId, { applyApkBuiltDedup: false });
                return;
            }

            if (cleanText.startsWith('/apk')) {
                if (await handleApkSlashCommands(message, cleanText)) {
                    return;
                }
            }

            // 命令: /start
            if (cleanText === '/start') {
                console.log(chalk.gray('收到 /start 命令'));
                console.log(
                    `🤖 WG-WEB 自动打包（用户号）\n\n` +
                    `使用方法:\n` +
                    `1️⃣ 打包单个分支:\n` +
                    `   打包 V5futebol\n` +
                    `   打包 x-12\n\n` +
                    `2️⃣ 打包多个分支（空格隔开）:\n` +
                    `   打包 V5futebol x-12 main\n\n` +
                    `3️⃣ 上传压缩包 → 自动配置检测 + 加入 APK 等待队列\n\n` +
                    `4️⃣ 穿透 分支名 → 启动 dev 并分享临时公网链接（约 10 分钟）\n\n` +
                    `终止打包 - 中断当前 zip 构建并清空排队\n\n` +
                    `取消打包:\n` +
                    `取消 V5futebol\n\n` +
                    `命令:\n` +
                    `/queue /branches /status\n` +
                    `/apk_list /apk_add /apk_del /apk_start_all /apk_clear\n` +
                    `/help - APK 队列命令说明`
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

                const applyApkBuiltDedup = false;

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

            // 终止当前 zip 打包（无需分支名）
            if (trimmedText === '终止打包') {
                if (!isUserAllowed(senderId)) {
                    console.log(chalk.red(`拒绝访问: 用户 ${senderId} 无权限`));
                    return;
                }
                await handleStopBuild(senderId, message);
                return;
            }

            // 穿透：启动分支 dev 服务并通过 cloudflared 分享临时公网链接（默认 10 分钟）
            if (trimmedText.startsWith('穿透')) {
                const branchTextForTunnel = trimmedText.substring(2).trim();

                if (!ENABLE_TUNNEL_ALL_USERS && !isUserAllowed(senderId)) {
                    console.log(chalk.red(`拒绝穿透: 用户 ${senderId} 无权限`));
                    return;
                }

                if (!branchTextForTunnel) {
                    try {
                        await client.sendMessage(message.chatId, {
                            message:
                                '❌ 穿透命令缺少分支名\n\n用法: 穿透 分支名\n示例: 穿透 7k-porco',
                            linkPreview: false,
                        });
                    } catch (error) {
                        console.log(chalk.yellow('发送消息失败:', error.message));
                    }
                    return;
                }

                const tunnelBranches = branchTextForTunnel
                    .split(/[\s\n\r]+/)
                    .map((b) => b.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '').trim())
                    .filter((b) => b.length > 0);

                if (tunnelBranches.length !== 1) {
                    try {
                        await client.sendMessage(message.chatId, {
                            message: '❌ 穿透一次仅支持一个分支名',
                            linkPreview: false,
                        });
                    } catch (error) {
                        console.log(chalk.yellow('发送消息失败:', error.message));
                    }
                    return;
                }

                const tunnelBranchInput = tunnelBranches[0];
                console.log(chalk.cyan(`收到穿透命令，分支: ${tunnelBranchInput}`));

                (async () => {
                    try {
                        const resolvedTunnel = await resolveProjectAndBranch(tunnelBranchInput);
                        if (!resolvedTunnel) {
                            await client.sendMessage(message.chatId, {
                                message: `❌ 穿透失败：分支 ${tunnelBranchInput} 在 WG-WEB / WGAME-WEB 中均未找到`,
                                linkPreview: false,
                            });
                            return;
                        }

                        const tunProject = resolvedTunnel.project;
                        const tunBranch = resolvedTunnel.actualBranchName;

                        if (isProjectGitWorkspaceBusy(tunProject.name)) {
                            let busyHint = `${tunProject.name} 正在打包、APK 或配置检测`;
                            if (isProjectZipPackBusy(tunProject.name)) {
                                const who =
                                    isBuilding && currentBuildProjectName === tunProject.name
                                        ? currentBuildBranch
                                        : null;
                                busyHint = who
                                    ? `${tunProject.name} 正在打包 ${who}`
                                    : `${tunProject.name} 有分支在打包队列中`;
                            }
                            await client.sendMessage(message.chatId, {
                                message:
                                    `⚠️ ${busyHint}，与穿透会争抢同一仓库工作区\n` +
                                    `请等待完成后再穿透 ${tunBranch}`,
                                linkPreview: false,
                            });
                            return;
                        }

                        const tunnelResult = await branchTunnel.start({
                            project: tunProject,
                            branchName: tunBranch,
                            chatId: message.chatId,
                            client,
                            enqueueProjectGitWork,
                            ensureProjectOnBranchForAnalyze,
                        });

                        const remainMin = Math.max(
                            1,
                            Math.round((tunnelResult.expiresAt - Date.now()) / 60000),
                        );
                        let tunnelMsg =
                            `🔌 穿透 ${tunnelResult.branchName}\n` +
                            `📁 项目：${tunnelResult.projectName}\n` +
                            `🔗 ${tunnelResult.publicUrl}\n` +
                            `⏱️ 约 ${remainMin} 分钟有效`;
                        if (tunnelResult.tunnelMode === 'localtunnel') {
                            if (tunnelResult.accessIp) {
                                tunnelMsg +=
                                    `\n\n⚠️ localtunnel 首次打开需在页面填写公网 IP：\n` +
                                    `${tunnelResult.accessIp}\n` +
                                    `（须与运行 bot 的本机出口 IP 一致；更推荐开 Clash TUN 后用 cloudflared）`;
                            } else {
                                tunnelMsg +=
                                    `\n\n⚠️ localtunnel 需在页面填写公网 IP，请在 bot 所在电脑执行：\n` +
                                    `curl https://loca.lt/mytunnelpassword`;
                            }
                        }
                        await client.sendMessage(message.chatId, {
                            message: tunnelMsg,
                            linkPreview: false,
                        });
                    } catch (tunnelErr) {
                        const tunnelMsg = (tunnelErr && tunnelErr.message) || String(tunnelErr);
                        console.log(chalk.yellow(`穿透失败: ${tunnelMsg}`));
                        try {
                            await client.sendMessage(message.chatId, {
                                message: `❌ 穿透失败:\n${tunnelMsg}`,
                                linkPreview: false,
                            });
                        } catch (sendErr) {
                            console.log(chalk.yellow('发送穿透失败提示失败:', sendErr.message));
                        }
                    }
                })();
                return;
            }

            // 检查是否是"检测"命令（默认关闭，仅上传压缩包时自动检测）
            if (trimmedText.startsWith('检测')) {
                if (!ENABLE_MANUAL_DETECT) {
                    console.log(
                        chalk.gray(
                            '已忽略「检测」命令（未开启 ENABLE_MANUAL_DETECT，请上传压缩包触发自动检测）',
                        ),
                    );
                    return;
                }
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

            await tryDeleteTriggerMessage(message, '打包');

            shouldCancelBuild = false;
            const packToken = buildAbortToken;
            isPackPreparing = true;

            // 验证分支是否存在（在 WG-WEB / WGAME-WEB 两个仓库中查找）
            console.log(chalk.cyan(`\n🔍 验证分支是否存在...`));
            const resolvedBuildTargets = [];
            const invalidBuildBranches = [];

            try {
                for (const item of packItems) {
                    if (isBuildAborted(packToken)) {
                        console.log(chalk.yellow('打包已终止（验证分支期间）'));
                        return;
                    }
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

                if (isBuildAborted(packToken)) {
                    console.log(chalk.yellow('打包已终止（验证分支完成后）'));
                    return;
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

                // 过滤掉已在队列中或正在打包的分支
                const newTargets = [];
                const duplicateBranches = [];

                for (const target of resolvedBuildTargets) {
                    const branchName = target.actualBranchName;
                    const projectName =
                        target.project && target.project.name ? target.project.name : '';

                    if (isProjectTunnelActive(projectName)) {
                        const tunBranch = getProjectTunnelBranch(projectName);
                        duplicateBranches.push(
                            `${branchName}（${projectName} 正在穿透 ${tunBranch || '?'}，请先等穿透结束）`,
                        );
                        continue;
                    }

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

                if (isBuildAborted(packToken)) {
                    console.log(chalk.yellow('打包已终止（启动构建前）'));
                    return;
                }

                // 处理多个分支（只处理新的有效分支）
                for (let i = 0; i < newTargets.length; i++) {
                    if (isBuildAborted(packToken)) {
                        console.log(chalk.yellow('打包已终止（启动构建前）'));
                        return;
                    }

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
                            timestamp: new Date(),
                            abortToken: packToken,
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
                                abortToken: packToken,
                            });
                        } catch (error) {
                            console.error(chalk.red('打包失败:'), error);
                        }

                        // 释放打包状态并处理下一个
                        isBuilding = false;
                        currentBuildBranch = '';
                        currentBuildProjectName = '';
                        currentBuildId = null;
                        shouldCancelBuild = false;

                        setTimeout(() => {
                            processNextInQueue();
                            scheduleNextQueuedFileAnalyze(1000);
                        }, 2000);
                    })();
                }

                return;
            } finally {
                isPackPreparing = false;
            }

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

            sweepExpiredZipBuildBundles();

            // 压缩包：入队（ZIP_PENDING）与配置检测（ZIP_ANALYZE）可独立开关
            if (!ENABLE_ZIP_PENDING && !ENABLE_ZIP_ANALYZE) {
                console.log(
                    chalk.gray(
                        `收到压缩包但 ZIP_PENDING/ZIP_ANALYZE 均已关闭，已跳过: ${fileName}`,
                    ),
                );
                return;
            }

            const branchFromFile = extractBranchNameFromFileName(fileName);
            if (!branchFromFile) {
                console.log(chalk.gray(`手动上传压缩包但未能从文件名解析分支，已跳过: ${fileName}`));
                try {
                    await client.sendMessage(message.chatId, {
                        message:
                            `❌ 无法从压缩包文件名解析分支\n📄 文件：${fileName}\n💡 请使用形如「分支名.zip」的文件名（如 7k-porco.zip）`,
                        linkPreview: false,
                    });
                } catch (sendErr) {
                    console.log(chalk.yellow('发送压缩包解析失败提示失败:', sendErr.message));
                }
                return;
            }

            console.log(
                chalk.cyan('已收到压缩包，对应分支:'),
                branchFromFile,
                '文件名:',
                fileName,
            );

            const shouldDirectApkNow = ENABLE_APK_CRON && isInApkAutoDirectWindow();
            if (shouldDirectApkNow) {
                try {
                    await client.sendMessage(message.chatId, {
                        message:
                            `📦 收到压缩包\n🌿 分支：${branchFromFile}\n🚀 当前处于 4:00-5:00 自动打包时段，已直接触发 APK 打包`,
                        linkPreview: false,
                    });
                } catch (sendErr) {
                    console.log(chalk.yellow('发送压缩包直打提示失败:', sendErr.message));
                }

                await enqueueApkBuild(branchFromFile, message.chatId, {
                    applyApkBuiltDedup: true,
                });
            } else if (ENABLE_ZIP_PENDING) {
                apkTracker.addOrUpdate(branchFromFile, {
                    source: 'zip_auto',
                    fileName,
                    chatId: message.chatId,
                    messageId: message.id,
                });
                try {
                    await client.sendMessage(message.chatId, {
                        message:
                            `📦 收到压缩包\n🌿 分支：${branchFromFile}\n✅ 已加入「等待打包 APK」队列`,
                        linkPreview: false,
                    });
                } catch (sendErr) {
                    console.log(chalk.yellow('发送压缩包入队提示失败:', sendErr.message));
                }
            }

            const bundleKey = makeZipBuildBundleKey(message.chatId, branchFromFile);
            const pendingBundle = pendingZipBuildBundles.get(bundleKey);
            let zipBundleDelivered = false;
            if (pendingBundle && !pendingBundle.delivered) {
                try {
                    zipBundleDelivered = await deliverZipBuildBundle(
                        message.chatId,
                        branchFromFile,
                        fileName,
                    );
                    if (zipBundleDelivered) {
                        console.log(
                            chalk.green(
                                `✓ 压缩包已上传，已合并发送检测信息与配置截图: ${branchFromFile}`,
                            ),
                        );
                        return;
                    }
                    console.log(
                        chalk.yellow(
                            `打包待发缓存未成功合并发送，改走独立配置检测: ${branchFromFile}`,
                        ),
                    );
                } catch (e) {
                    console.log(
                        chalk.yellow(
                            `合并发送检测/截图失败: ${(e && e.message) || e}`,
                        ),
                    );
                }
            }

            // 本号发出的构建 zip 若已合并发送则跳过；否则（如手动用本号上传）仍做独立检测
            if (message.out && zipBundleDelivered) {
                console.log(
                    chalk.gray(
                        `跳过本号发出的压缩包独立检测（已与打包结果合并发送）: ${fileName}`,
                    ),
                );
                return;
            }

            if (ENABLE_ZIP_ANALYZE) {
                scheduleZipConfigAnalyzeFromBranch({
                    branchName: branchFromFile,
                    fileName,
                    chatId: message.chatId,
                }).catch((e) => {
                    console.log(chalk.yellow(`群压缩包配置检测失败: ${(e && e.message) || e}`));
                });
            } else if (message.out) {
                console.log(
                    chalk.gray(
                        `跳过本号发出的压缩包独立检测（ENABLE_ZIP_ANALYZE=false）: ${fileName}`,
                    ),
                );
            } else {
                console.log(
                    chalk.gray(
                        `已关闭压缩包配置检测（ENABLE_ZIP_ANALYZE=false），仅${ENABLE_ZIP_PENDING ? '入队' : '记录'}分支 ${branchFromFile}`,
                    ),
                );
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
        currentFileProcessTask = task;

        try {
            await enqueueProjectGitWork(project.name, async () => {
                try {
                    await ensureProjectOnBranchForAnalyze(project, actualBranchName);
                    await deliverZipConfigAnalyze({
                        fileName,
                        actualBranchName,
                        project,
                        chatId,
                        branchName,
                    });
                } catch (error) {
                    const msg = (error && error.message) || String(error);
                    if (/Pull 多次失败/i.test(msg)) {
                        console.log(
                            chalk.red(
                                `❌ Pull 多次失败 ${project.name}/${actualBranchName}: ${msg}`,
                            ),
                        );
                        return;
                    }
                    console.error(chalk.red(`处理文件失败: ${msg}`));
                    try {
                        await client.sendMessage(chatId, {
                            message: `处理文件失败: ${msg}`,
                        });
                    } catch (err) {
                        console.log(chalk.yellow('发送消息失败:', err.message));
                    }
                } finally {
                    await cleanupLocalBranchesInGitLock(project);
                }
            });
        } finally {
            // 释放处理状态
            isProcessingFile = false;
            currentFileProcessTask = null;

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

    /** 该分支是否仍被 zip/APK/文件检测队列占用（避免 cleanup 删掉即将 checkout 的分支） */
    function isBranchReservedForProject(projectName, branch) {
        if (!projectName || !branch) return false;
        if (
            isBuilding &&
            currentBuildProjectName === projectName &&
            gitBranchMatches(currentBuildBranch, branch)
        ) {
            return true;
        }
        if (
            isApkBuilding &&
            currentApkBuildProjectName === projectName &&
            gitBranchMatches(currentApkBuildBranch, branch)
        ) {
            return true;
        }
        if (
            buildQueue.some(
                (t) =>
                    t.project &&
                    t.project.name === projectName &&
                    gitBranchMatches(t.branchName, branch),
            )
        ) {
            return true;
        }
        if (
            apkBuildQueue.some(
                (t) =>
                    t.projectName === projectName && gitBranchMatches(t.branchName, branch),
            )
        ) {
            return true;
        }
        if (
            fileProcessQueue.some(
                (t) =>
                    t.project &&
                    t.project.name === projectName &&
                    gitBranchMatches(t.actualBranchName || t.branchName, branch),
            )
        ) {
            return true;
        }
        if (
            currentFileProcessTask &&
            currentFileProcessTask.project &&
            currentFileProcessTask.project.name === projectName &&
            gitBranchMatches(
                currentFileProcessTask.actualBranchName || currentFileProcessTask.branchName,
                branch,
            )
        ) {
            return true;
        }
        if (isProjectTunnelActive(projectName)) {
            const tunBranch = getProjectTunnelBranch(projectName);
            if (gitBranchMatches(tunBranch, branch)) {
                return true;
            }
        }
        return false;
    }

    function hasPendingWorkForProject(projectName) {
        if (!projectName) return false;
        if (isProjectTunnelActive(projectName)) return true;
        if (isBuilding && currentBuildProjectName === projectName) return true;
        if (isApkBuilding && currentApkBuildProjectName === projectName) return true;
        if (isProcessingFile) {
            if (
                currentFileProcessTask &&
                currentFileProcessTask.project &&
                currentFileProcessTask.project.name === projectName
            ) {
                return true;
            }
            const busy = fileProcessQueue.some((t) => t.project && t.project.name === projectName);
            if (busy) return true;
        }
        if (buildQueue.some((t) => t.project && t.project.name === projectName)) return true;
        if (apkBuildQueue.some((t) => t.projectName === projectName)) return true;
        return false;
    }

    // 清理单个项目本地分支（须在 enqueueProjectGitWork 内调用）
    async function cleanupLocalBranchesForProject(proj) {
        if (!proj || !proj.builder) return;

        console.log(chalk.cyan(`🧹 清理本地分支 [${proj.name}]（保留 main/master）...`));

        const branchesResult = await proj.builder.runCommand('git branch');
        if (!branchesResult.success) {
            console.log(chalk.yellow(`⚠ [${proj.name}] 获取分支列表失败`));
            return;
        }

        const branches = branchesResult.output
            .split('\n')
            .map((b) => b.trim().replace(/^\*\s*/, ''))
            .filter((b) => b.length > 0)
            .filter((b) => b !== 'main' && b !== 'master');

        if (branches.length === 0) {
            console.log(chalk.gray(`✓ [${proj.name}] 没有需要清理的分支`));
            return;
        }

        let deletedCount = 0;
        for (const branch of branches) {
            if (isBranchReservedForProject(proj.name, branch)) {
                console.log(chalk.gray(`跳过删除 [${proj.name}] ${branch}（队列或构建中仍占用）`));
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

    async function cleanupLocalBranchesInGitLock(project) {
        if (!project || !project.name) return;
        if (hasPendingWorkForProject(project.name)) {
            console.log(chalk.gray(`[${project.name}] 跳过清理本地分支：仍有 zip/APK/检测任务排队或执行中`));
            return;
        }
        await enqueueProjectGitWork(project.name, () => cleanupLocalBranchesForProject(project));
    }

    async function cleanupAllProjectsWhenIdle() {
        if (
            isBuilding ||
            isApkBuilding ||
            isProcessingFile ||
            buildQueue.length > 0 ||
            apkBuildQueue.length > 0 ||
            fileProcessQueue.length > 0
        ) {
            console.log(chalk.gray('跳过全局清理本地分支：仍有任务队列未清空'));
            return;
        }
        for (const proj of projects) {
            if (proj && proj.name) {
                await cleanupLocalBranchesInGitLock(proj);
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
                        await ensureProjectOnBranchForAnalyze(project, actualBranchName);

                        const headBeforeRead = await getProjectGitHeadBranch(project);
                        if (!gitBranchMatches(headBeforeRead, actualBranchName)) {
                            userBotLog.append(
                                'DETECT',
                                `拒绝输出检测结果 分支错位 ${project.name} expected=${actualBranchName} HEAD=${headBeforeRead}`,
                            );
                            console.log(
                                chalk.red(
                                    `❌ [${project.name}] 检测中止：HEAD(${headBeforeRead}) 与目标分支(${actualBranchName})不一致`,
                                ),
                            );
                            return;
                        }

                        console.log(chalk.cyan(`📖 [${project.name}] 读取配置文件（HEAD=${headBeforeRead}）...`));
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
                        const msg = (error && error.message) || String(error);
                        if (/Pull 多次失败/i.test(msg)) {
                            userBotLog.append(
                                'DETECT',
                                `Pull 失败不输出检测结果 ${project.name}/${actualBranchName}: ${msg}`,
                            );
                            console.log(chalk.red(`❌ [${project.name}] Pull 失败: ${msg}`));
                            return;
                        }
                        results.push({
                            projectName: project.name,
                            branchName: info.actualBranchName,
                            success: false,
                            error: msg,
                        });
                        console.error(chalk.red(`检测分支 ${info.actualBranchName} 失败: ${msg}`));
                    }
                });
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
            try {
                await cleanupAllProjectsWhenIdle();
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

    /** 终止当前 zip 打包：删触发消息、中断进行中构建、清空排队 */
    async function handleStopBuild(senderId, message) {
        await tryDeleteTriggerMessage(message, '终止打包');

        const wasBuilding = isBuilding;
        const wasPreparing = isPackPreparing;
        const clearedQueue = buildQueue.length;

        requestStopAllBuilds();
        buildQueue = [];

        if (wasBuilding) {
            const who =
                currentBuildProjectName && currentBuildBranch
                    ? `${currentBuildProjectName}/${currentBuildBranch}`
                    : currentBuildBranch || '…';
            console.log(chalk.yellow(`终止打包: 正在中断 ${who} (操作者: ${senderId})`));
        }
        if (wasPreparing) {
            console.log(chalk.yellow(`终止打包: 已取消准备中的打包 (操作者: ${senderId})`));
        }
        if (clearedQueue > 0) {
            console.log(chalk.yellow(`终止打包: 已清空排队 ${clearedQueue} 个任务`));
        }
        if (!wasBuilding && !wasPreparing && clearedQueue === 0) {
            console.log(chalk.gray('终止打包: 当前无进行中的 zip 打包任务'));
        }
    }

    /** 批量打包/APK 前各仓库只刷新一次远程分支列表（避免 26 分支 × 2 仓库 = 52 次 git fetch） */
    async function warmProjectBranchesCache() {
        for (const proj of projects) {
            if (!proj || !proj.builder) continue;
            proj.builder._branchesCache = null;
            try {
                await proj.builder.getBranches();
                console.log(chalk.gray(`✓ [${proj.name}] 分支列表已预加载（批量解析共用缓存）`));
            } catch (e) {
                console.log(
                    chalk.yellow(`⚠ [${proj.name}] 预加载分支列表失败: ${(e && e.message) || e}`),
                );
            }
        }
    }

    // 在多个项目中解析出对应的项目和分支名（先 WG-WEB，再 WGAME-WEB）
    async function resolveProjectAndBranch(branchName, options = {}) {
        const trimmedBranch = (branchName || '').trim().replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '');
        if (!trimmedBranch) return null;

        const reuseBranchCache = Boolean(options && options.reuseBranchCache);

        for (const proj of projects) {
            if (!reuseBranchCache) {
                proj.builder._branchesCache = null;
            }
            try {
                const { valid } = await proj.builder.validateBranches([trimmedBranch], {
                    reuseCache: reuseBranchCache,
                });
                if (valid && valid.length > 0) {
                    return {
                        project: proj,
                        actualBranchName: valid[0],
                    };
                }

                if (reuseBranchCache) {
                    continue;
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

    async function getProjectGitHeadBranch(project) {
        const r = await project.builder.runCommand('git rev-parse --abbrev-ref HEAD');
        return r.success ? String(r.output || '').trim() : '';
    }

    function gitBranchMatches(actual, expected) {
        const a = (actual || '').trim().toLowerCase();
        const e = (expected || '').trim().toLowerCase();
        return Boolean(a && e && a === e);
    }

    /** 压缩包配置检测：切分支 + pull，并在读取 config 前确认 HEAD 与目标一致 */
    async function ensureProjectOnBranchForAnalyze(project, targetBranch) {
        const target = (targetBranch || '').trim();
        if (!target) {
            throw new Error('目标分支名为空');
        }

        let head = await getProjectGitHeadBranch(project);
        if (!gitBranchMatches(head, target)) {
            if (config.build.autoFetchPull) {
                console.log(chalk.cyan(`📥 [${project.name}] 获取远程分支信息...`));
                const fetchResult = await project.builder.runCommand('git fetch --all');
                if (!fetchResult.success) {
                    console.log(chalk.yellow(`⚠ Fetch 失败，继续尝试切换分支...`));
                } else {
                    console.log(chalk.green('✓ Fetch 完成'));
                }
            }
            await safeCheckoutBranch(project, target);
            head = await getProjectGitHeadBranch(project);
        } else {
            console.log(chalk.gray(`当前已在分支 ${target}，拉取最新代码...`));
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
                    await new Promise((r) => setTimeout(r, pullDelayMs));
                }
            }
            if (!pullResult || !pullResult.success) {
                const errDetail = (pullResult && pullResult.error) || '未知错误';
                userBotLog.append(
                    'ANALYZE',
                    `Pull 失败不输出检测结果 ${project.name}/${target}: ${errDetail}`,
                );
                throw new Error(`Pull 多次失败: ${errDetail}`);
            }
            console.log(chalk.green('✓ 代码已更新到最新'));
        }

        head = await getProjectGitHeadBranch(project);
        if (!gitBranchMatches(head, target)) {
            await safeCheckoutBranch(project, target);
            head = await getProjectGitHeadBranch(project);
        }
        if (!gitBranchMatches(head, target)) {
            throw new Error(
                `Git 工作区分支与目标不一致（目标 ${target}，当前 ${head || '未知'}）`,
            );
        }
    }

    /** 压缩包检测结果：主域名列表（与历史格式一致） */
    function formatZipAnalyzeMainDomains(result) {
        const mainDomains = Array.isArray(result.mainDomains) ? result.mainDomains : [];
        const seen = new Set();
        const uniqueMain = mainDomains
            .map((d) => String(d).trim())
            .filter(Boolean)
            .filter((d) => {
                const key = d.toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

        if (uniqueMain.length === 0) {
            return '';
        }

        let block = `\n\n🌐 主域名:\n`;
        uniqueMain.forEach((d) => {
            block += `- ${d}\n`;
        });
        return block;
    }

    function sweepExpiredZipBuildBundles() {
        const now = Date.now();
        for (const [key, bundle] of pendingZipBuildBundles.entries()) {
            if (now - (bundle.createdAt || 0) > ZIP_BUILD_BUNDLE_TTL_MS) {
                tryUnlinkPngs(bundle.pngPath);
                pendingZipBuildBundles.delete(key);
                console.log(chalk.gray(`已过期清理打包待发缓存: ${key}`));
            }
        }
    }

    function buildZipAnalyzeMessage(fileName, actualBranchName, project, result) {
        const envText = result.debug !== undefined ? (result.debug ? '测试服' : '正式服') : '未知';
        const debugFlagText = result.debug !== undefined ? String(result.debug) : '未检测到';
        const appName = result.appName || '未检测到';

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

        msg += formatZipAnalyzeMainDomains(result);
        return msg.trimEnd();
    }

    /** 在 Git 锁内读取 config，生成检测文案（不发送） */
    async function collectZipConfigAnalyzePayload({
        fileName,
        actualBranchName,
        project,
        branchName,
    }) {
        console.log(chalk.cyan(`📖 [${project.name}] 读取配置文件（分支 ${actualBranchName}）...`));
        const result = await readPackageIdFromBranch(project.path, actualBranchName);

        if (result.success) {
            const msg = buildZipAnalyzeMessage(fileName, actualBranchName, project, result);
            const pkgWarn = branchPackageExpect.buildExpectationWarnings(actualBranchName, {
                packageId: result.packageId,
                debug: result.debug,
            });
            if (pkgWarn.plain) {
                console.log(chalk.red(pkgWarn.plain.trim()));
            }
            console.log(
                chalk.green(
                    `✅ 分支 ${actualBranchName} packageId: ${result.packageId}, appName: ${result.appName || '未检测到'}`,
                ),
            );
            return {
                success: true,
                message: msg,
                pkgWarn,
                result,
                actualBranchName,
                branchName: branchName || actualBranchName,
            };
        }

        const errorMsg =
            `📦 ${fileName}\n` +
            `📁 项目: ${project.name} | 分支: ${actualBranchName}\n` +
            `❌ 未检测到 packageId 配置`;
        console.log(chalk.red(`❌ 分支 ${actualBranchName} 未检测到 packageId 配置`));
        return {
            success: false,
            message: errorMsg,
            pkgWarn: null,
            result: null,
            actualBranchName,
            branchName: branchName || actualBranchName,
        };
    }

    async function sendZipConfigAnalyzePayload(chatId, payload, fileName) {
        const { actualBranchName, branchName, project, pkgWarn, result } = payload;

        if (result && result.success) {
            pendingApkOptions.set(actualBranchName, {
                packageId: result.packageId,
                appName: result.appName,
                appNameSlug: result.appNameSlug,
                primaryDomain: result.primaryDomain,
            });
            try {
                apkTracker.addOrUpdate(actualBranchName, {
                    source: 'analyzed',
                    fileName,
                    chatId,
                    packageId: result.packageId || null,
                    appName: result.appName,
                    appNameSlug: result.appNameSlug || null,
                    primaryDomain: result.primaryDomain || null,
                });
            } catch (err) {
                console.log(chalk.yellow(`写入 apk-pending.json 失败（可忽略）: ${err.message}`));
            }
        }

        try {
            await withTimeout(
                client.sendMessage(chatId, {
                    message: payload.message,
                    linkPreview: false,
                }),
                TELEGRAM_SEND_MESSAGE_TIMEOUT_MS,
                `Telegram sendMessage(压缩包检测) ${actualBranchName}`,
            );
        } catch (error) {
            console.log(chalk.yellow('发送压缩包检测结果失败:', error.message));
        }

        if (pkgWarn && pkgWarn.html) {
            await sendPackageMismatchAlert(chatId, {
                fileName,
                branchName: actualBranchName,
                pkgWarn,
            });
        }
    }

    function clearZipBuildBundle(chatId, branchName, reason) {
        const key = makeZipBuildBundleKey(chatId, branchName);
        const bundle = pendingZipBuildBundles.get(key);
        if (!bundle) return;
        tryUnlinkPngs(bundle.pngPath);
        pendingZipBuildBundles.delete(key);
        if (reason) {
            console.log(chalk.gray(`已清理打包待发缓存 [${branchName}]: ${reason}`));
        }
    }

    /**
     * 打包 checkout 后：同一次拉代码内收集检测信息 + 生成配置截图，等待 zip 上传后再发送
     */
    async function prepareZipBuildBundleAfterCheckout(project, branchName, chatId) {
        sweepExpiredZipBuildBundles();

        const head = await getProjectGitHeadBranch(project);
        if (!gitBranchMatches(head, branchName)) {
            console.log(
                chalk.yellow(
                    `[${project.name}] 跳过后台预收集：HEAD(${head}) 与 ${branchName} 不一致`,
                ),
            );
            return;
        }

        const provisionalFileName = `${branchName}.zip`;
        const payload = await collectZipConfigAnalyzePayload({
            fileName: provisionalFileName,
            actualBranchName: branchName,
            project,
            branchName,
        });
        payload.project = project;
        payload.chatId = chatId;

        let pngPath = null;
        try {
            pngPath = await renderConfigScreenshots(project.path, {
                projectLabel: project.name,
                branchName,
            });
        } catch (err) {
            console.log(
                chalk.yellow(
                    `[${branchName}] 配置截图预生成失败（zip 上传后仍发检测文案）: ${(err && err.message) || err}`,
                ),
            );
        }

        const key = makeZipBuildBundleKey(chatId, branchName);
        clearZipBuildBundle(chatId, branchName, '覆盖旧缓存');
        pendingZipBuildBundles.set(key, {
            chatId,
            projectName: project.name,
            branchName,
            pngPath,
            payload,
            delivered: false,
            createdAt: Date.now(),
        });

        userBotLog.append(
            'ZIP',
            `bundle_prepared ${project.name}/${branchName} 等待压缩包上传后合并发送`,
        );
        console.log(
            chalk.cyan(
                `[${branchName}] 已预收集检测信息与配置截图，等待压缩包上传完成后一并发送`,
            ),
        );
    }

    /**
     * zip 上传完成后发送：检测文案 + 配置截图（打包流程合并输出）
     * @returns {boolean} 是否命中并发出了待发缓存
     */
    async function deliverZipBuildBundle(chatId, branchName, fileName) {
        const key = makeZipBuildBundleKey(chatId, branchName);
        const bundle = pendingZipBuildBundles.get(key);
        if (!bundle || bundle.delivered) {
            return false;
        }
        bundle.delivered = true;

        const project = bundle.payload && bundle.payload.project;
        const actualBranchName = bundle.branchName;
        const payload = bundle.payload;

        if (payload && project) {
            if (payload.success && payload.result) {
                payload.message = buildZipAnalyzeMessage(
                    fileName,
                    actualBranchName,
                    project,
                    payload.result,
                );
            } else if (!payload.success) {
                payload.message =
                    `📦 ${fileName}\n` +
                    `📁 项目: ${project.name} | 分支: ${actualBranchName}\n` +
                    `❌ 未检测到 packageId 配置`;
            }
            payload.fileName = fileName;

            await sendZipConfigAnalyzePayload(chatId, payload, fileName);
        }

        if (bundle.pngPath && fs.existsSync(bundle.pngPath)) {
            try {
                await withTimeout(
                    client.sendFile(chatId, {
                        file: bundle.pngPath,
                        forceDocument: false,
                    }),
                    TELEGRAM_SEND_FILE_TIMEOUT_MS,
                    `Telegram sendFile(配置截图) ${actualBranchName}`,
                );
            } catch (err) {
                console.log(
                    chalk.yellow(
                        `[${actualBranchName}] 配置截图发送失败: ${(err && err.message) || err}`,
                    ),
                );
            }
        }

        tryUnlinkPngs(bundle.pngPath);
        pendingZipBuildBundles.delete(key);
        userBotLog.append(
            'ZIP',
            `bundle_delivered ${bundle.projectName}/${actualBranchName} file=${fileName}`,
        );
        return true;
    }

    /**
     * 在已确认 HEAD 与 actualBranchName 一致后读取 config 并发送压缩包检测结果（调用方需在 Git 串行锁内）
     */
    async function deliverZipConfigAnalyze({ fileName, actualBranchName, project, chatId, branchName }) {
        const head = await getProjectGitHeadBranch(project);
        if (!gitBranchMatches(head, actualBranchName)) {
            const detail = `expected=${actualBranchName} HEAD=${head || '?'}`;
            userBotLog.append('ANALYZE', `拒绝输出检测结果 分支错位 ${project.name} ${detail} file=${fileName}`);
            console.log(
                chalk.red(
                    `❌ [${project.name}] 压缩包检测中止：工作区分支(${head})与目标(${actualBranchName})不一致，避免误报`,
                ),
            );
            return;
        }

        const payload = await collectZipConfigAnalyzePayload({
            fileName,
            actualBranchName,
            project,
            branchName,
        });
        payload.project = project;
        payload.chatId = chatId;
        await sendZipConfigAnalyzePayload(chatId, payload, fileName);
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

    // 将 APK 打包任务加入队列，按顺序执行（按钮、文本命令、/apk_start_all 等）
    async function enqueueApkBuild(branchName, chatId, { applyApkBuiltDedup = false } = {}) {
        // 先解析项目和实际分支名，用于后续统一去重与展示
        let displayProject = '未知项目';
        let displayBranch = branchName;
        let resolvedActualBranch = branchName;
        let project = null;

        try {
            const resolved = await resolveProjectAndBranch(branchName);
            if (!resolved) {
                console.log(
                    chalk.yellow(
                        `分支 ${branchName} 在 WG-WEB / WGAME-WEB 中均未找到，已跳过（不向群发送单条失败提示）`,
                    ),
                );
                return;
            }
            project = resolved.project;
            displayProject = project && project.name ? project.name : displayProject;
            displayBranch = resolved.actualBranchName || branchName;
            resolvedActualBranch = resolved.actualBranchName || branchName;
        } catch (error) {
            console.log(
                chalk.yellow(`验证分支失败(队列加入时)，已跳过 ${branchName}: ${error.message}`),
            );
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
            console.log(
                chalk.yellow(
                    `分支 ${branchName} 在 WG-WEB / WGAME-WEB 中均未找到，已跳过（不向群发送单条失败提示）`,
                ),
            );
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

        await ensureProjectOnBranchForAnalyze(project, branchName);
        const head = await getProjectGitHeadBranch(project);
        if (!gitBranchMatches(head, branchName)) {
            throw new Error(
                `Git 工作区分支与 APK 目标不一致（目标 ${branchName}，当前 ${head || '未知'}）`,
            );
        }

        // 从当前分支配置读取 appDownPath / proxyShareUrlList / packageId
        try {
            console.log(chalk.cyan(`📖 从当前分支配置解析（HEAD=${head}）...`));
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

            const tempDir = paths.tmpDir;
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

        const tempDir = paths.tmpDir;
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

        console.log(
            chalk.cyan(`🔍 批量解析 ${branchNames.length} 个 APK 分支（预加载远程分支列表）...`),
        );
        await warmProjectBranchesCache();

        for (let i = 0; i < branchNames.length; i++) {
            const rawName = branchNames[i];
            const name = (rawName || '').trim();
            if (!name) continue;
            console.log(chalk.gray(`  [${i + 1}/${branchNames.length}] 解析分支 ${name}...`));
            try {
                const resolved = await resolveProjectAndBranch(name, { reuseBranchCache: true });
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
        console.log(
            chalk.cyan(
                `✓ 批量解析完成：有效 ${resolvedTargets.length} 个` +
                (resolvedTargets.length
                    ? `（${resolvedTargets.map((t) => t.branchName).join(', ')}）`
                    : ''),
            ),
        );
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

    function buildApkBatchSummaryText(orderedBranches, outcomes, invalidBranches = []) {
        const successList = orderedBranches.filter(b => outcomes.get(b) === 'success');
        const skippedList = orderedBranches.filter(b => outcomes.get(b) === 'skipped');
        const failureFromBuild = orderedBranches.filter(
            b => outcomes.get(b) !== 'success' && outcomes.get(b) !== 'skipped',
        );
        const notFoundList = Array.isArray(invalidBranches)
            ? invalidBranches.map((b) => String(b).trim()).filter(Boolean)
            : [];
        const failureItems = [
            ...failureFromBuild.map((b) => ({ label: b, suffix: '' })),
            ...notFoundList.map((b) => ({
                label: b,
                suffix: '（仓库中不存在，已跳过）',
            })),
        ];

        const successCount = successList.length;
        const failureCount = failureItems.length;
        const skippedCount = skippedList.length;

        let summaryMsg = `📊 APK 批量打包统计\n\n✅ 成功 ${successCount} 条`;
        if (successList.length) {
            summaryMsg += '\n' + successList.map((b, i) => `${i + 1}. ${b}`).join('\n');
        }
        summaryMsg += `\n\n⏭️ 跳过（曾成功打包） ${skippedCount} 条`;
        if (skippedList.length) {
            summaryMsg += '\n' + skippedList.map((b, i) => `${i + 1}. ${b}`).join('\n');
        }
        summaryMsg += `\n\n❌ 失败 ${failureCount} 条`;
        if (failureItems.length) {
            summaryMsg +=
                '\n' +
                failureItems.map((item, i) => `${i + 1}. ${item.label}${item.suffix}`).join('\n');
        }
        return summaryMsg;
    }

    /** 批量 APK 结束后从 apk-pending 移除本批全部分支（成功/失败/未找到均清除） */
    function clearApkPendingBranchesAfterBatch(branchNames) {
        const seen = new Set();
        let removed = 0;
        for (const raw of branchNames || []) {
            const name = (raw || '').trim();
            if (!name) continue;
            const key = name.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            try {
                apkTracker.remove(name);
                removed++;
            } catch (rmErr) {
                console.log(
                    chalk.yellow(`批量结束后移除 pending「${name}」失败（可忽略）:`, rmErr.message),
                );
            }
        }
        if (removed > 0) {
            console.log(
                chalk.gray(`批量 APK 已完成，已从 apk-pending 移除本批 ${removed} 个分支`),
            );
        }
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
        const summaryMsg = buildApkBatchSummaryText(
            ref.orderedBranches,
            ref.outcomes,
            ref.invalidBranches || [],
        );
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
        const sessionInvalidBranches = [];
        const sessionInputBranchNames = [];
        let sessionChatId = null;

        try {
            while (apkBatchChunkQueue.length > 0) {
                const chunks = [];
                while (apkBatchChunkQueue.length > 0) {
                    chunks.push(apkBatchChunkQueue.shift());
                }

                const newTargets = [];
                let sessionApplyApkDedup = false;
                for (const chunk of chunks) {
                    if (Array.isArray(chunk.inputBranchNames)) {
                        for (const b of chunk.inputBranchNames) {
                            const name = (b || '').trim();
                            if (name && !sessionInputBranchNames.includes(name)) {
                                sessionInputBranchNames.push(name);
                            }
                        }
                    }
                    if (Array.isArray(chunk.invalidBranches)) {
                        for (const b of chunk.invalidBranches) {
                            const name = (b || '').trim();
                            if (name && !sessionInvalidBranches.includes(name)) {
                                sessionInvalidBranches.push(name);
                            }
                        }
                    }
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

                console.log(
                    chalk.cyan(
                        `📋 开始准备 ${newTargets.length} 个分支的 APK 环境（拉代码 / Logo / 配置）…`,
                    ),
                );

                const contexts = [];
                for (let pi = 0; pi < newTargets.length; pi++) {
                    const target = newTargets[pi];
                    const { project, branchName } = target;
                    console.log(
                        chalk.cyan(
                            `  [${pi + 1}/${newTargets.length}] 准备 ${project.name}/${branchName}…`,
                        ),
                    );
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
                    console.log(chalk.yellow('本批无分支进入打包（可能均已去重跳过或准备失败）'));
                    continue;
                }

                console.log(
                    chalk.cyan(
                        `🚀 开始打包 ${contexts.length} 个分支（并发上限 ${process.env.APK_MAX_CONCURRENCY || 2}）…`,
                    ),
                );

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

            const summaryMsg = buildApkBatchSummaryText(
                orderedBranches,
                outcomes,
                sessionInvalidBranches,
            );

            apkBatchEditableSummaryRef = {
                chatId: sessionChatId,
                messageId: null,
                orderedBranches: orderedBranches.slice(),
                outcomes: new Map(outcomes),
                invalidBranches: sessionInvalidBranches.slice(),
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

            clearApkPendingBranchesAfterBatch(sessionInputBranchNames);
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
            console.log(chalk.red('❌ 批量打包中没有任何有效分支，仅发汇总'));
            const summaryMsg = buildApkBatchSummaryText([], new Map(), invalidBranches);
            try {
                await client.sendMessage(chatId, { message: summaryMsg, linkPreview: false });
            } catch (e) {
                console.log(chalk.yellow('发送批量汇总失败:', e.message || e));
            }
            clearApkPendingBranchesAfterBatch(branchNames);
            return;
        }

        if (invalidBranches.length > 0) {
            console.log(
                chalk.yellow(
                    `⚠ 以下分支未找到，将仅在最终汇总中列出: ${invalidBranches.join(', ')}`,
                ),
            );
        }

        apkBatchChunkQueue.push({
            resolvedTargets,
            chatId,
            applyApkBuiltDedup,
            invalidBranches: invalidBranches.slice(),
            inputBranchNames: branchNames
                .map((b) => (b || '').trim())
                .filter(Boolean),
        });

        if (!apkBatchWorkerPromise) {
            apkBatchWorkerPromise = runApkBatchWorkerLoop().catch((err) => {
                console.error(chalk.red('批量 APK worker 异常:'), err);
            });
        }
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

                    const zipDisplayName =
                        result.zipFileName ||
                        (result.zipFilePath ? path.basename(result.zipFilePath) : '') ||
                        `${branchName}.zip`;
                    try {
                        const merged = await deliverZipBuildBundle(
                            chatId,
                            branchName,
                            zipDisplayName,
                        );
                        if (merged) {
                            log(chalk.green('已合并发送检测信息与配置截图'));
                        }
                    } catch (bundleErr) {
                        log(
                            chalk.yellow(
                                `合并发送检测/截图失败: ${(bundleErr && bundleErr.message) || bundleErr}`,
                            ),
                        );
                    }

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

            if (result && result.zipFilePath && fs.existsSync(result.zipFilePath)) {
                fs.unlinkSync(result.zipFilePath);
                log('已清理临时文件');
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

        await prepareZipBuildBundleAfterCheckout(project, branchName, chatId);
    }

    // 执行构建流程（可复用函数，使用指定 project 的 builder）
    async function executeBuild(project, branchName, senderId, chatId, buildOptions = {}) {
        const abortToken =
            buildOptions.abortToken != null ? buildOptions.abortToken : buildAbortToken;
        const log = (...args) => console.log(chalk.blue(`[${branchName}]`), ...args);

        if (isBuildAborted(abortToken)) {
            log(chalk.yellow('任务已终止（构建开始前）'));
            clearZipBuildBundle(chatId, branchName, '构建已取消');
            return { cancelled: true };
        }

        if (isProjectTunnelActive(project.name)) {
            const tunBranch = getProjectTunnelBranch(project.name);
            log(
                chalk.yellow(
                    `跳过构建：${project.name} 正在穿透 ${tunBranch || '?'}，避免切换分支`,
                ),
            );
            clearZipBuildBundle(chatId, branchName, '穿透占用工作区');
            return { cancelled: false };
        }

        shouldCancelBuild = false;
        const buildRunner = project && project.builder ? project.builder : builder;
        const packageIdTarget =
            buildOptions.packageId != null && Number.isFinite(buildOptions.packageId)
                ? buildOptions.packageId
                : null;

        const updateProgress = async (stage, percent, msg) => {
            if (isBuildAborted(abortToken)) return;
            const text = msg || stage || '';
            if (percent === 100 || percent % 20 === 0) {
                log(`${percent}%`, text);
            }
        };

        const fullBuildOptions = {
            afterCheckout: async () => {
                if (isBuildAborted(abortToken)) {
                    throw new Error('BUILD_ABORTED');
                }
                await handleAfterCheckoutForBuild(project, branchName, chatId, packageIdTarget);
                if (isBuildAborted(abortToken)) {
                    throw new Error('BUILD_ABORTED');
                }
            },
        };

        const result = await enqueueProjectGitWork(project.name, async () => {
            if (isBuildAborted(abortToken)) {
                return { success: false, error: 'BUILD_ABORTED' };
            }
            const buildResult = await buildRunner.fullBuild(
                branchName,
                updateProgress,
                fullBuildOptions,
            );
            return buildResult;
        });

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
                    `build_failure ${project && project.name ? project.name : 'UNKNOWN'}/${branchName}: ${(result && result.error) || 'unknown_error'
                    }`,
                );
            }
        } catch {
            // 日志失败不影响主流程
        }

        if (isBuildAborted(abortToken)) {
            log(chalk.yellow('任务已中断'));
            clearZipBuildBundle(chatId, branchName, '构建已取消');
            if (result && result.zipFilePath && fs.existsSync(result.zipFilePath)) {
                fs.unlinkSync(result.zipFilePath);
            }
            return { cancelled: true };
        }

        if (!result.success) {
            log(chalk.red(`构建失败: ${result.error}`));
            clearZipBuildBundle(chatId, branchName, '构建失败');
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
        if (isBuildAborted(nextTask.abortToken)) {
            console.log(chalk.yellow(`跳过已终止的队列任务: ${nextTask.branchName}`));
            setTimeout(() => processNextInQueue(), 200);
            return;
        }

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
                abortToken: nextTask.abortToken,
            });
        } catch (error) {
            console.error(chalk.red('队列任务处理失败:'), error);
        }

        // 重置状态
        isBuilding = false;
        currentBuildBranch = '';
        currentBuildProjectName = '';
        currentBuildId = null;
        shouldCancelBuild = false;

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
    if (branchTunnelManager) {
        try {
            for (const proj of ['WGAME-WEB', 'WG-WEB']) {
                await branchTunnelManager.stop(proj, '进程退出');
            }
        } catch (_) {
            // ignore
        }
    }
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

