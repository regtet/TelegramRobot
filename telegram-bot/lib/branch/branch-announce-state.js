/**
 * 按群缓存「第 1 条」分支命名参考（第 2 条复刻台分包行可穿插他人消息后配对）。
 * 持久化到 data/branch-announce-pending.json，重启不丢；超过 TTL 自动丢弃。
 */

const fs = require('fs');
const path = require('path');
const { branchAnnouncePendingFile: PENDING_FILE } = require('../paths');

const PENDING_TTL_MS = parseInt(
    process.env.BRANCH_ANNOUNCE_PENDING_TTL_MS || String(4 * 60 * 60 * 1000),
    10,
);

/** @type {Map<string, { branchNameHint: string, matchTokens: string[], updatedAt: number, senderId: string }>} */
const pendingByChat = new Map();

function makePendingKey(chatId) {
    return String(chatId || '').trim();
}

function isExpired(entry) {
    return !entry || Date.now() - entry.updatedAt > PENDING_TTL_MS;
}

function readDiskDb() {
    try {
        if (!fs.existsSync(PENDING_FILE)) return {};
        const raw = fs.readFileSync(PENDING_FILE, 'utf8').trim();
        if (!raw) return {};
        const data = JSON.parse(raw);
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
        return {};
    }
}

function writeDiskDb() {
    const out = {};
    for (const [key, entry] of pendingByChat.entries()) {
        if (!entry || isExpired(entry)) continue;
        out[key] = entry;
    }
    fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
    fs.writeFileSync(PENDING_FILE, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
}

function loadFromDisk() {
    const db = readDiskDb();
    let purged = 0;
    for (const [key, entry] of Object.entries(db)) {
        if (!entry || isExpired(entry)) {
            purged += 1;
            continue;
        }
        pendingByChat.set(key, {
            branchNameHint: entry.branchNameHint,
            matchTokens: Array.isArray(entry.matchTokens) ? entry.matchTokens.slice() : [],
            updatedAt: Number(entry.updatedAt) || Date.now(),
            senderId: String(entry.senderId || ''),
        });
    }
    if (purged > 0) {
        writeDiskDb();
        console.log(
            `[公告] 已清理 ${purged} 条超过 ${Math.round(PENDING_TTL_MS / 3600000)} 小时未配对的命名参考`,
        );
    }
}

loadFromDisk();

function logPendingExpired(chatId, entry) {
    const hours = Math.round(PENDING_TTL_MS / 3600000);
    console.log(
        `[公告] 命名参考已过期（${hours}h 内未收到复刻台分包行，已丢弃）: ${entry.branchNameHint}（群 ${chatId}，原发送者 ${entry.senderId || '-'}）`,
    );
}

function setPendingBranchHint(chatId, senderId, hint) {
    if (!chatId || !hint || !hint.branchNameHint) return;
    const key = makePendingKey(chatId);
    pendingByChat.set(key, {
        branchNameHint: hint.branchNameHint,
        matchTokens: Array.isArray(hint.matchTokens) ? hint.matchTokens.slice() : [],
        updatedAt: Date.now(),
        senderId: String(senderId || ''),
    });
    writeDiskDb();
}

function getPendingBranchHint(chatId, _senderId) {
    const key = makePendingKey(chatId);
    const p = pendingByChat.get(key);
    if (!p) return null;
    if (isExpired(p)) {
        pendingByChat.delete(key);
        writeDiskDb();
        logPendingExpired(chatId, p);
        return null;
    }
    return p;
}

function clearPendingBranchHint(chatId, _senderId) {
    const key = makePendingKey(chatId);
    if (!pendingByChat.delete(key)) return;
    writeDiskDb();
}

module.exports = {
    setPendingBranchHint,
    getPendingBranchHint,
    clearPendingBranchHint,
    makePendingKey,
    PENDING_TTL_MS,
};
