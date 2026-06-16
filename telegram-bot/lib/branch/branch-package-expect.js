const { normalizeForMatch, MIN_TOKEN_LEN } = require('./branch-group-auto-parse');
const { readJson, writeJsonAtomic } = require('../core/json-store');

const { branchPackageExpectFile: DATA_FILE } = require('../paths');

function readDb() {
    const data = readJson(DATA_FILE, {});
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function writeDb(data) {
    writeJsonAtomic(DATA_FILE, data);
}

function normalizeBranchKey(branch) {
    return (branch || '').trim().toLowerCase();
}

function uniqueTokens(tokens) {
    const seen = new Set();
    const out = [];
    for (const t of tokens || []) {
        const s = String(t || '').trim().toLowerCase();
        if (s.length < MIN_TOKEN_LEN || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
    }
    return out;
}

/**
 * 写入/覆盖期望分包（精确 key + matchTokens 模糊匹配）
 */
function setFromAnnounce(branch, { packageId, series } = {}) {
    const key = normalizeBranchKey(branch);
    if (!key || packageId == null || String(packageId).trim() === '') return;
    const db = readDb();
    const prev = db[key] || {};
    db[key] = {
        branch: (branch || '').trim(),
        packageId: String(packageId).trim(),
        series: series != null ? String(series) : prev.series || null,
        branchNameHint: prev.branchNameHint || key,
        matchTokens: uniqueTokens([...(prev.matchTokens || []), key]),
        domains: prev.domains || [],
        updatedAt: new Date().toISOString(),
        source: 'group_announce',
    };
    writeDb(db);
}

/**
 * 群内两条消息合并后的任务记录
 * @param {{ recordKey: string, packageId: string, series?: string, branchNameHint?: string, matchTokens?: string[], domains?: string[] }} task
 */
function setFromAnnounceTask(task) {
    if (!task || !task.recordKey || task.packageId == null || String(task.packageId).trim() === '') {
        return;
    }
    const key = normalizeBranchKey(task.recordKey);
    if (!key) return;

    const db = readDb();
    const tokens = uniqueTokens([
        task.branchNameHint,
        task.recordKey,
        ...(task.matchTokens || []),
        ...(task.domains || []),
    ]);

    db[key] = {
        branch: key,
        packageId: String(task.packageId).trim(),
        series: task.series != null ? String(task.series) : null,
        branchNameHint: (task.branchNameHint || key).toLowerCase(),
        matchTokens: tokens,
        domains: Array.isArray(task.domains) ? task.domains.map((d) => String(d).toLowerCase()) : [],
        updatedAt: new Date().toISOString(),
        source: 'group_announce',
    };
    writeDb(db);
}

function getForBranch(branch) {
    const key = normalizeBranchKey(branch);
    if (!key) return null;
    const db = readDb();
    return db[key] || null;
}

/**
 * 判断公告 token 是否匹配 Git 分支名（避免 baralho777 误命中 alho777 等子串）
 */
function tokenMatchesBranch(normBranch, nt, entry) {
    if (!normBranch || !nt || nt.length < MIN_TOKEN_LEN) return false;
    if (normBranch === nt) return true;
    if (nt.includes(normBranch)) return true;

    if (!normBranch.includes(nt)) return false;
    if (!normBranch.endsWith(nt)) return false;

    const prefix = normBranch.slice(0, normBranch.length - nt.length);
    if (!prefix) return true;

    const entryBranchNorm = normalizeForMatch(entry.branch || entry.branchNameHint || '');
    if (entryBranchNorm === normBranch) return true;

    if (entryBranchNorm.endsWith(nt)) {
        const expectedPrefix = entryBranchNorm.slice(0, entryBranchNorm.length - nt.length);
        if (prefix === expectedPrefix) return true;
    }

    const seriesNorm = normalizeForMatch(entry.series || '');
    if (seriesNorm && prefix === seriesNorm) return true;

    return false;
}

/**
 * 按 Git 分支名模糊匹配公告记录（第 1 条 token + 第 2 条 packageId）
 */
function resolveExpectationForBranch(branchName) {
    const exact = getForBranch(branchName);
    if (exact) return exact;

    const normBranch = normalizeForMatch(branchName);
    if (!normBranch || normBranch.length < MIN_TOKEN_LEN) return null;

    const db = readDb();
    let best = null;
    let bestScore = 0;

    for (const entry of Object.values(db)) {
        if (!entry || entry.packageId == null) continue;
        const tokenSet = new Set();
        if (entry.branchNameHint) tokenSet.add(String(entry.branchNameHint).toLowerCase());
        if (entry.branch) tokenSet.add(String(entry.branch).toLowerCase());
        for (const t of entry.matchTokens || []) {
            if (t) tokenSet.add(String(t).toLowerCase());
        }
        for (const d of entry.domains || []) {
            for (const t of hostTokensFromDomain(d)) tokenSet.add(t);
        }

        for (const token of tokenSet) {
            const nt = normalizeForMatch(token);
            if (nt.length < MIN_TOKEN_LEN) continue;
            if (!tokenMatchesBranch(normBranch, nt, entry)) continue;
            const score = nt.length;
            if (score > bestScore) {
                bestScore = score;
                best = entry;
            }
        }
    }

    return best;
}

function hostTokensFromDomain(host) {
    const h = String(host || '').toLowerCase().trim();
    if (!h) return [];
    const out = [h];
    const compact = normalizeForMatch(h);
    if (compact.length >= MIN_TOKEN_LEN) out.push(compact);
    return out;
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function buildMismatchWarningBody(exp, cur, want) {
    const seriesHint = exp.series ? `系列 ${exp.series}，` : '';
    const hint = exp.branchNameHint ? `（命名参考 ${exp.branchNameHint}）` : '';
    return `⚠️ 分包与群内公告不一致：${seriesHint}公告记录 packageId=${want}${hint}，当前代码 packageId=${cur}`;
}

/**
 * zip/检测：对比代码 packageId 与群内公告期望
 * @returns {{ plain: string, html: string }} plain 纯文本；html 为 Telegram HTML（加粗+🔴，非真红色）
 */
function buildExpectationWarnings(branchName, { packageId, debug } = {}) {
    const exp = resolveExpectationForBranch(branchName);
    if (!exp || packageId == null || String(packageId).trim() === '') {
        return { plain: '', html: '' };
    }
    const cur = String(packageId).trim();
    const want = String(exp.packageId).trim();
    if (want === cur) {
        return { plain: '', html: '' };
    }
    const body = buildMismatchWarningBody(exp, cur, want);
    return {
        plain: `\n\n${body}`,
        // Telegram 不支持字体颜色；用 🔴 + <b> 在客户端里最醒目
        html: `\n\n<b>🔴 ${escapeHtml(body)}</b>`,
    };
}

module.exports = {
    setFromAnnounce,
    setFromAnnounceTask,
    getForBranch,
    resolveExpectationForBranch,
    buildExpectationWarnings,
    escapeHtml,
};
