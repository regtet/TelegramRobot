const fs = require('fs');
const path = require('path');

/** 所有运行时日志文件统一放在 telegram-bot/logs/ */
const LOGS_DIR = path.join(__dirname, '..', 'logs');

function ensureLogsDir() {
    if (!fs.existsSync(LOGS_DIR)) {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    return LOGS_DIR;
}

/** @param {string} filename 如 user-bot.log、branch-ops.log */
function pathInLogs(filename) {
    ensureLogsDir();
    return path.join(LOGS_DIR, filename);
}

/** 日志用本地时间：YYYY-MM-DD HH:mm:ss */
function formatLogTime(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    const p = (n, len = 2) => String(n).padStart(len, '0');
    return (
        `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
        `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    );
}

module.exports = {
    ensureLogsDir,
    LOGS_DIR,
    pathInLogs,
    formatLogTime,
};
