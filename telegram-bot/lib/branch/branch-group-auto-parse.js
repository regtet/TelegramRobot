/**
 * 解析群内复刻台任务公告：
 * - 第 1 条（常单独发）：单行域名 → 分支命名参考 / matchTokens（如 www.EscolhaPG.vip → escolhapg）
 * - 第 2 条：复刻台 + 分包ID + 域名行 → 期望 packageId 与域名列表
 * 两条可穿插他人消息，靠 per-chat pending 配对。
 */

const MIN_TOKEN_LEN = 4;

function extractHostRootFromDomainLine(line) {
    const raw = (line || '').trim();
    if (!raw) return null;
    const stripped = raw
        .replace(/（\s*备\s*）\s*$/i, '')
        .replace(/\(\s*备\s*\)\s*$/i, '')
        .trim();
    const t = stripped.toLowerCase();
    const m = t.match(/^([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*)\.[a-z]{2,}$/i);
    if (!m) return null;
    const hostRoot = m[1];
    return hostRoot.startsWith('www.') ? hostRoot.slice(4) : hostRoot;
}

function lineLooksLikeBackup(line) {
    return /（\s*备\s*）|(\(\s*备\s*\))|（\s*备份\s*）|备用/i.test(line || '');
}

function isSingleLineDomainOnlyMessage(trimmedText) {
    if (!trimmedText || /[\r\n]/.test(trimmedText)) return false;
    if (/复刻台/.test(trimmedText)) return false;
    return extractHostRootFromDomainLine(trimmedText) !== null;
}

function contentLines(trimmedText) {
    return trimmedText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'));
}

function normalizeSeriesKeyForStore(upperToken) {
    const u = (upperToken || '').trim().toUpperCase();
    if (u === 'BET') return 'BET经典版';
    return upperToken;
}

function normalizeForMatch(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function hostToMatchTokens(hostRoot) {
    const tokens = new Set();
    if (!hostRoot) return [];
    const lower = hostRoot.toLowerCase().trim();
    if (lower.length >= MIN_TOKEN_LEN) tokens.add(lower);
    const compact = normalizeForMatch(lower);
    if (compact.length >= MIN_TOKEN_LEN) tokens.add(compact);
    for (const part of lower.split('.')) {
        if (part.length >= MIN_TOKEN_LEN) tokens.add(part);
    }
    return [...tokens];
}

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
                seriesTokenUpper: seriesRaw.toUpperCase(),
            };
        }
    }
    return null;
}

function collectDomainTokensFromLines(lines) {
    const tokens = new Set();
    const domains = [];
    for (const line of lines) {
        const host = extractHostRootFromDomainLine(line);
        if (!host) continue;
        domains.push(host);
        for (const t of hostToMatchTokens(host)) tokens.add(t);
    }
    return { domains, tokens: [...tokens] };
}

/**
 * 第 1 条：单行域名（分支命名参考）
 * @returns {null | { branchNameHint: string, matchTokens: string[] }}
 */
function tryParseBranchNameHintMessage(trimmedText) {
    if (!isSingleLineDomainOnlyMessage(trimmedText)) return null;
    const host = extractHostRootFromDomainLine(trimmedText);
    if (!host) return null;
    return {
        branchNameHint: host,
        matchTokens: hostToMatchTokens(host),
    };
}

/**
 * 第 2 条：复刻台 + 分包ID + 域名配置（可与 pending 的第 1 条配对）
 * @param {null | { branchNameHint: string, matchTokens: string[] }} pendingHint
 */
function tryParseReplicaConfigMessage(trimmedText, pendingHint) {
    const lines = contentLines(trimmedText);
    const header = findReplicaHeaderLine(lines);
    if (!header || header.packageId == null || String(header.packageId).trim() === '') {
        return null;
    }

    const { domains, tokens: domainTokens } = collectDomainTokensFromLines(lines);
    const matchTokens = new Set(domainTokens);

    if (pendingHint) {
        if (pendingHint.branchNameHint) {
            for (const t of hostToMatchTokens(pendingHint.branchNameHint)) matchTokens.add(t);
        }
        if (Array.isArray(pendingHint.matchTokens)) {
            for (const t of pendingHint.matchTokens) {
                if (t && String(t).length >= MIN_TOKEN_LEN) matchTokens.add(String(t).toLowerCase());
            }
        }
    }

    const firstLine = lines[0] || '';
    const firstHost =
        !/复刻台/.test(firstLine) ? extractHostRootFromDomainLine(firstLine) : null;
    if (firstHost) {
        for (const t of hostToMatchTokens(firstHost)) matchTokens.add(t);
    }

    const branchNameHint =
        (pendingHint && pendingHint.branchNameHint) || firstHost || domains[0] || null;
    if (!branchNameHint) return null;

    const recordKey = branchNameHint.toLowerCase();
    const filteredTokens = [...matchTokens].filter((t) => t && t.length >= MIN_TOKEN_LEN);

    return {
        recordKey,
        branchNameHint,
        series: normalizeSeriesKeyForStore(header.seriesTokenUpper),
        packageId: String(header.packageId).trim(),
        matchTokens: filteredTokens,
        domains,
    };
}

/** @deprecated 保留旧导出；请用 tryParseBranchNameHintMessage + tryParseReplicaConfigMessage */
function tryParseSeriesAnnounceForBranchUpdate(trimmedText, prevHostRoot) {
    if (!prevHostRoot) return null;
    return tryParseReplicaConfigMessage(trimmedText, {
        branchNameHint: prevHostRoot,
        matchTokens: hostToMatchTokens(prevHostRoot),
    });
}

function unixSecondsToBranchTimeTokens(unixSec) {
    const d = new Date(Number(unixSec) * 1000);
    const h = d.getHours();
    const mi = d.getMinutes();
    return [`${h}.${String(mi).padStart(2, '0')}`];
}

module.exports = {
    extractHostRootFromDomainLine,
    isSingleLineDomainOnlyMessage,
    tryParseBranchNameHintMessage,
    tryParseReplicaConfigMessage,
    tryParseSeriesAnnounceForBranchUpdate,
    unixSecondsToBranchTimeTokens,
    hostToMatchTokens,
    normalizeForMatch,
    MIN_TOKEN_LEN,
};
