const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', '..', 'branch-package-expect.json');

function readDb() {
    try {
        if (!fs.existsSync(DATA_FILE)) return {};
        const raw = fs.readFileSync(DATA_FILE, 'utf8').trim();
        if (!raw) return {};
        const data = JSON.parse(raw);
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
        return {};
    }
}

function writeDb(data) {
    fs.writeFileSync(DATA_FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function normalizeBranchKey(branch) {
    return (branch || '').trim().toLowerCase();
}

/**
 * 写入/覆盖某分支在群内公告中的期望分包 ID（按分支名小写索引）
 */
function setFromAnnounce(branch, { packageId, series } = {}) {
    const key = normalizeBranchKey(branch);
    if (!key || packageId == null || String(packageId).trim() === '') return;
    const db = readDb();
    db[key] = {
        branch: (branch || '').trim(),
        packageId: String(packageId).trim(),
        series: series != null ? String(series) : null,
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
 * 根据群内记录的期望分包 + 当前代码 debug，生成检测提醒文案（无则返回空串）
 */
function buildExpectationWarnings(branchName, { packageId, debug } = {}) {
    const parts = [];
    const exp = getForBranch(branchName);
    if (exp && packageId != null && String(packageId).trim() !== '') {
        const cur = String(packageId).trim();
        const want = String(exp.packageId).trim();
        if (want !== cur) {
            const seriesHint = exp.series ? `系列 ${exp.series}，` : '';
            parts.push(
                `⚠️ 分包与群内公告不一致：${seriesHint}公告记录 packageId=${want}，当前代码 packageId=${cur}`,
            );
        }
    }
    if (debug === true) {
        parts.push('⚠️ debug=true：当前为测试服配置，请确认是否使用正式包。');
    }
    if (parts.length === 0) return '';
    return `\n\n${parts.join('\n')}`;
}

module.exports = {
    setFromAnnounce,
    getForBranch,
    buildExpectationWarnings,
};
