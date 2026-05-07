/**
 * 解析群内「单行域名 + {系列} 复刻台 分包ID … + 多行域名」类消息，用于自动更新 branchList.json。
 * 识别关键字为「复刻台」与「分包ID」，系列代码为该行首词（mk、bet、xw、DY 等）。
 * 若存在「（备）」行且主机名为「{系列小写}-…」形态（如 dy-acharpg），优先用该主机名作为 Git 分支名。
 */

function extractHostRootFromDomainLine(line) {
    const raw = (line || '').trim();
    if (!raw) return null;
    // 去掉行尾说明如「（备）」「(备)」再取主机名
    const stripped = raw
        .replace(/（\s*备\s*）\s*$/i, '')
        .replace(/\(\s*备\s*\)\s*$/i, '')
        .trim();
    const t = stripped.toLowerCase();
    const m = t.match(/^([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*)\.[a-z]{2,}$/i);
    if (!m) return null;
    const hostRoot = m[1];
    // 群公告里常出现 www.xxx.com，这里统一去掉 www. 前缀，避免写入 branchList 时污染分支名
    return hostRoot.startsWith('www.') ? hostRoot.slice(4) : hostRoot;
}

function lineLooksLikeBackup(line) {
    return /（\s*备\s*）|(\(\s*备\s*\))|（\s*备份\s*）|备用/i.test(line || '');
}

/** 整段消息仅为单行域名（如 casacopg.com），用于与下一条公告配对 */
function isSingleLineDomainOnlyMessage(trimmedText) {
    if (!trimmedText || /[\r\n]/.test(trimmedText)) return false;
    return extractHostRootFromDomainLine(trimmedText) !== null;
}

function unixSecondsToBranchTimeTokens(unixSec) {
    const d = new Date(Number(unixSec) * 1000);
    const h = d.getHours();
    const mi = d.getMinutes();
    return [`${h}.${String(mi).padStart(2, '0')}`];
}

function contentLines(trimmedText) {
    return trimmedText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/** 群内简称 → branchList.json 中的 key（resolveCanonicalKey 不区分大小写） */
function normalizeSeriesKeyForStore(upperToken) {
    const u = (upperToken || '').trim().toUpperCase();
    if (u === 'BET') return 'BET经典版';
    return upperToken;
}

/**
 * 解析「{token} 复刻台 分包ID {n}」行：首词为系列，分包 ID 为数字。
 * 支持「分包ID」与「分包 ID」两种写法。
 */
const PKG_ID_FRAGMENT = '分包\\s*ID';

function findReplicaHeaderLine(lines) {
    for (const l of lines) {
        const hasPkgId = new RegExp(PKG_ID_FRAGMENT, 'i').test(l);
        if (!/复刻台/.test(l) || !hasPkgId) continue;
        const m = l.match(
            new RegExp(`^(\\S+)\\s+复刻台\\s+${PKG_ID_FRAGMENT}\\s*[：:]?\\s*(\\d+)`, 'i'),
        );
        if (m) {
            const seriesRaw = m[1].trim();
            if (!seriesRaw) continue;
            return {
                seriesRaw,
                packageId: m[2].trim(),
                headerLine: l,
                seriesTokenUpper: seriesRaw.toUpperCase(),
            };
        }
        const m2 = l.match(new RegExp(`^(\\S+)\\s+复刻台\\s+${PKG_ID_FRAGMENT}`, 'i'));
        if (m2) {
            const seriesRaw = m2[1].trim();
            if (!seriesRaw) continue;
            return {
                seriesRaw,
                packageId: null,
                headerLine: l,
                seriesTokenUpper: seriesRaw.toUpperCase(),
            };
        }
    }
    return null;
}

/**
 * @param {string} trimmedText
 * @param {string|null} prevHostRoot 上一条仅域名的主机前缀（如 1777mk、365xv）
 * @returns {null | { seriesToken: string, branch: string, packageId: string|null, timeTokens: null }}
 */
function tryParseSeriesAnnounceForBranchUpdate(trimmedText, prevHostRoot) {
    const lines = contentLines(trimmedText);
    if (lines.length < 2) return null;

    const header = findReplicaHeaderLine(lines);
    if (!header) return null;

    const prev = (prevHostRoot || '').trim().toLowerCase();
    // 新规则：公告里 XX 仅作为系列标识；分支名只使用同发送者上一条“单行域名”。
    // 「XX 复刻台 ...」后续域名行全部忽略，不参与分支拼接或兜底。
    if (!prev) {
        return null;
    }

    return {
        seriesToken: normalizeSeriesKeyForStore(header.seriesTokenUpper),
        branch: prev,
        packageId: header.packageId,
        timeTokens: null,
    };
}

module.exports = {
    extractHostRootFromDomainLine,
    isSingleLineDomainOnlyMessage,
    unixSecondsToBranchTimeTokens,
    tryParseSeriesAnnounceForBranchUpdate,
};
