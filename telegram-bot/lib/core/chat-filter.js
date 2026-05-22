/**
 * Userbot 会话过滤：支持工作群 incoming + 收藏夹/私聊机器人等「自己发出的」打包指令。
 */

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
function shouldHandleUserbotMessage(message, allowedChatIds, selfUserId) {
    if (!message) return false;

    const chatIdStr =
        message.chatId != null && typeof message.chatId.toString === 'function'
            ? message.chatId.toString()
            : '';
    const senderId =
        message.senderId != null && typeof message.senderId.toString === 'function'
            ? message.senderId.toString()
            : '';
    const isOutgoing = Boolean(message.out);

    if (!allowedChatIds || allowedChatIds.size === 0) {
        return true;
    }

    if (!isOutgoing) {
        return allowedChatIds.has(chatIdStr);
    }

    if (selfUserId && senderId === selfUserId && isPackRelatedCommandText(message.text)) {
        return true;
    }

    return allowedChatIds.has(chatIdStr);
}

module.exports = {
    parseAllowedChatIds,
    isPackRelatedCommandText,
    shouldHandleUserbotMessage,
};
