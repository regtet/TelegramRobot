/**
 * 按群缓存「第 1 条」分支命名参考（单行域名），供「第 2 条」复刻台分包块配对。
 * 中间穿插他人消息不清空，仅超时失效。
 */

const PENDING_TTL_MS = parseInt(process.env.BRANCH_ANNOUNCE_PENDING_TTL_MS || String(4 * 60 * 60 * 1000), 10);

/** @type {Map<string, { branchNameHint: string, matchTokens: string[], updatedAt: number }>} */
const pendingByChat = new Map();

function setPendingBranchHint(chatId, hint) {
    if (!chatId || !hint || !hint.branchNameHint) return;
    pendingByChat.set(String(chatId), {
        branchNameHint: hint.branchNameHint,
        matchTokens: Array.isArray(hint.matchTokens) ? hint.matchTokens.slice() : [],
        updatedAt: Date.now(),
    });
}

function getPendingBranchHint(chatId) {
    const key = String(chatId);
    const p = pendingByChat.get(key);
    if (!p) return null;
    if (Date.now() - p.updatedAt > PENDING_TTL_MS) {
        pendingByChat.delete(key);
        return null;
    }
    return p;
}

function clearPendingBranchHint(chatId) {
    pendingByChat.delete(String(chatId));
}

module.exports = {
    setPendingBranchHint,
    getPendingBranchHint,
    clearPendingBranchHint,
    PENDING_TTL_MS,
};
