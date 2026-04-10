const fs = require('fs');
const { pathInLogs, LOGS_DIR, formatLogTime } = require('./app-logs');

const LOG_FILE = pathInLogs('user-bot.log');

function append(category, message) {
    try {
        const text = typeof message === 'string' ? message : String(message);
        const line = `[${formatLogTime()}] [${category}] ${text}\n`;
        fs.appendFileSync(LOG_FILE, line, 'utf8');
    } catch {
        // 避免日志失败影响主流程
    }
}

/** 启动时调用一次：立刻创建 logs 目录与 user-bot.log（否则仅在有 append 时才会生成文件） */
function initOnStartup() {
    try {
        const line = `[${formatLogTime()}] [BOOT] user-bot 已启动，后续 APK/S3/LIST 等详情写入本文件\n`;
        fs.appendFileSync(LOG_FILE, line, 'utf8');
    } catch (e) {
        console.error('[user-bot-logger] 初始化日志文件失败:', e && e.message ? e.message : e);
    }
}

module.exports = {
    append,
    LOG_FILE,
    LOGS_DIR,
    initOnStartup,
};
