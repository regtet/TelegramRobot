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
    return m ? m[1] : null;
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
 * 解析「{token} 复刻台 分包ID {n}」行：首词为系列，分包 ID 为数字
 */
function findReplicaHeaderLine(lines) {
    for (const l of lines) {
        if (!/复刻台/.test(l) || !/分包ID/i.test(l)) continue;
        const m = l.match(/^(\S+)\s+复刻台\s+分包ID\s*[：:]?\s*(\d+)/i);
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
        const m2 = l.match(/^(\S+)\s+复刻台\s+分包ID/i);
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
 * 主域名行：能解析出域名，且非「（备）」类说明行
 */
function collectPrimaryDomainHosts(lines, skipLineSet) {
    const hosts = [];
    for (const l of lines) {
        if (skipLineSet.has(l)) continue;
        if (lineLooksLikeBackup(l)) continue;
        const host = extractHostRootFromDomainLine(l);
        if (host) hosts.push(host);
    }
    return hosts;
}

/**
 * 在域名行中查找「{seriesSlug}-…」形态主机名；backupOnly=true 仅看（备）行，false 仅看非备行
 */
function findLastSeriesPrefixedHost(lines, skipLineSet, seriesSlug, backupOnly) {
    const slug = (seriesSlug || '').trim().toLowerCase();
    if (!slug) return null;
    const prefix = `${slug}-`;
    let last = null;
    for (const l of lines) {
        if (skipLineSet.has(l)) continue;
        if (backupOnly && !lineLooksLikeBackup(l)) continue;
        if (!backupOnly && lineLooksLikeBackup(l)) continue;
        const host = extractHostRootFromDomainLine(l);
        if (!host) continue;
        if (host.toLowerCase().startsWith(prefix)) {
            last = host;
        }
    }
    return last;
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

    const skipLineSet = new Set([header.headerLine]);
    const seriesSlug = header.seriesRaw.toLowerCase();

    // 1) 备线且为「系列-xxx」→ 整条分支名（如 dy-acharpg），本条内其它普通域名不参与拼接
    const backupSeriesHost = findLastSeriesPrefixedHost(lines, skipLineSet, seriesSlug, true);
    // 2) 非备行上的「系列-xxx」→ 与「同一人上一条域名」拼接（如 casacopg + xw-casacopg）
    const mainSeriesHost = findLastSeriesPrefixedHost(lines, skipLineSet, seriesSlug, false);

    const primaryHosts = collectPrimaryDomainHosts(lines, skipLineSet);
    if (primaryHosts.length === 0 && !backupSeriesHost && !mainSeriesHost) return null;

    const prev = (prevHostRoot || '').trim().toLowerCase();

    let branch;
    if (backupSeriesHost) {
        branch = backupSeriesHost;
    } else if (prev && mainSeriesHost) {
        branch = `${prev}${mainSeriesHost}`;
    } else if (mainSeriesHost) {
        branch = mainSeriesHost;
    } else if (prev && primaryHosts.length > 0) {
        const suffixHost = primaryHosts[primaryHosts.length - 1];
        branch = `${prev}${suffixHost}`;
    } else if (primaryHosts.length >= 2) {
        const firstHost = primaryHosts[0];
        const lastHost = primaryHosts[primaryHosts.length - 1];
        branch = firstHost === lastHost ? lastHost : `${firstHost}${lastHost}`;
    } else if (primaryHosts.length === 1) {
        branch = primaryHosts[0];
    } else {
        return null;
    }

    return {
        seriesToken: normalizeSeriesKeyForStore(header.seriesTokenUpper),
        branch,
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
