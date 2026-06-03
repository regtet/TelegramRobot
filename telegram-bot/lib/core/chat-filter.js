/**
 * Userbot 会话过滤：仅处理 CHAT_ID / CHAT_IDS 中配置的会话（群或指定私聊）。
 */

const { isAnnounceRelatedText } = require('../branch/branch-group-auto-parse');

function parseAllowedChatIds() {
    const ids = new Set();
    const parts = [process.env.CHAT_IDS || '', process.env.CHAT_ID || ''].join(',');
    for (const raw of parts.split(',')) {
        const t = raw.trim();
        if (t) ids.add(t);
    }
    return ids;
}

function isPackRelatedCommandText(text) {
    const t = (text || '').trim();
    if (!t) return false;
    return (
        t.startsWith('打包') ||
        t.startsWith('打包APK') ||
        t.startsWith('检测') ||
        t.startsWith('穿透') ||
        t.startsWith('/apk') ||
        t === '/help' ||
        t.startsWith('取消打包') ||
        t.startsWith('取消') ||
        t.startsWith('✅ 打包 APK') ||
        t.startsWith('❌ 不打包')
    );
}

/**
 * @param {object} message - GramJS Message
 * @param {Set<string>} allowedChatIds
 * @param {string|null} selfUserId
 */
function shouldHandleUserbotMessage(message, allowedChatIds, _selfUserId) {
    if (!message) return false;

    const chatIdStr =
        message.chatId != null && typeof message.chatId.toString === 'function'
            ? message.chatId.toString()
            : '';

    if (!allowedChatIds || allowedChatIds.size === 0) {
        return true;
    }

    return allowedChatIds.has(chatIdStr);
}

module.exports = {
    parseAllowedChatIds,
    isPackRelatedCommandText,
    isAnnounceRelatedText,
    shouldHandleUserbotMessage,
};
