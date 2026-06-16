/**
 * 压缩包配置检测结果的纯文本文案构建（无副作用）。
 * 从 index.js 抽出。
 */

/** 主域名列表块（去重，保持历史格式） */
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

/** 压缩包检测主文案 */
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

module.exports = {
    formatZipAnalyzeMainDomains,
    buildZipAnalyzeMessage,
};
