/**
 * 按群 + 发送者缓存「第 1 条」分支命名参考，避免多台子并行时串台。
 */

const PENDING_TTL_MS = parseInt(process.env.BRANCH_ANNOUNCE_PENDING_TTL_MS || String(4 * 60 * 60 * 1000), 10);

/** @type {Map<string, { branchNameHint: string, matchTokens: string[], updatedAt: number, senderId: string }>} */
const pendingByKey = new Map();

function makePendingKey(chatId, senderId) {
    const c = String(chatId || '').trim();
    const s = String(senderId || '').trim() || 'unknown';
    return `${c}:${s}`;
}

function setPendingBranchHint(chatId, senderId, hint) {
    if (!chatId || !hint || !hint.branchNameHint) return;
    const key = makePendingKey(chatId, senderId);
    pendingByKey.set(key, {
        branchNameHint: hint.branchNameHint,
        matchTokens: Array.isArray(hint.matchTokens) ? hint.matchTokens.slice() : [],
        updatedAt: Date.now(),
        senderId: String(senderId || ''),
    });
}

function getPendingBranchHint(chatId, senderId) {
    const key = makePendingKey(chatId, senderId);
    const p = pendingByKey.get(key);
    if (!p) return null;
    if (Date.now() - p.updatedAt > PENDING_TTL_MS) {
        pendingByKey.delete(key);
        return null;
    }
    return p;
}

function clearPendingBranchHint(chatId, senderId) {
    pendingByKey.delete(makePendingKey(chatId, senderId));
}

module.exports = {
    setPendingBranchHint,
    getPendingBranchHint,
    clearPendingBranchHint,
    makePendingKey,
    PENDING_TTL_MS,
};
