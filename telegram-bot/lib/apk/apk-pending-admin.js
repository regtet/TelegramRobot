const apkTracker = require('./apk-tracker');

/** 从标准 APK 成功通知文案中解析分支名 */
function extractBranchFromApkMessage(text) {
    const t = text || '';
    let m = t.match(/^✅\s*APK\s*打包完成\s*\|\s*([^|]+)\s*\|/m);
    if (m && m[1]) {
        return m[1].trim();
    }
    m = t.match(/^✅\s*APK\s*打包完成\s*\|\s*([^\n|]+?)\s*$/m);
    if (m && m[1]) {
        return m[1].trim();
    }
    return null;
}

/** 是否为带 APK 下载地址的标准成功通知 */
function isApkSuccessDoneMessage(text) {
    const body = (text || '').trim();
    return (
        Boolean(body) &&
        /^✅\s*APK\s*打包完成\s*\|/m.test(body) &&
        /APK地址:\s*\S+/m.test(body)
    );
}

function getUniquePendingBranches() {
    const all = apkTracker.getAll();
    return Array.from(
        new Set(all.map((item) => (item.branch || '').trim()).filter(Boolean)),
    );
}

/**
 * 解析 /apk_* 命令
 * @returns {{ cmd: string, args: string[] } | null}
 */
function parseApkSlashCommand(rawText) {
    const text = (rawText || '').trim();
    if (!text.startsWith('/apk')) return null;
    const parts = text.split(/\s+/);
    if (!parts.length) return null;
    const cmd = parts[0].split('@')[0];
    return { cmd, args: parts.slice(1) };
}

const APK_HELP_TEXT =
    '🤖 打包助手 - 命令列表\n\n' +
    '【APK 等待队列】\n' +
    '/apk_list - 查看等待打包 APK 列表\n' +
    '/apk_add 分支1 分支2 ... - 手动添加分支\n' +
    '/apk_del 分支1 分支2 ... - 从列表删除\n' +
    '/apk_start_all - 一键打包队列中全部分支\n' +
    '/apk_clear - 清空列表\n';

module.exports = {
    extractBranchFromApkMessage,
    isApkSuccessDoneMessage,
    getUniquePendingBranches,
    parseApkSlashCommand,
    APK_HELP_TEXT,
};
