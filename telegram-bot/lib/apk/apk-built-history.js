const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', '..', 'apk-built-history.json');

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

function makeKey(projectName, appNameSlug) {
    const p = (projectName || '').trim();
    const s = (appNameSlug || '').trim().toLowerCase();
    return `${p}|${s}`;
}

function isDedupDisabled() {
    return process.env.APK_SKIP_IF_ALREADY_BUILT === '0';
}

function wasAlreadyBuilt(projectName, appNameSlug) {
    if (isDedupDisabled()) return false;
    const key = makeKey(projectName, appNameSlug);
    if (!key.endsWith('|') && key.includes('|')) {
        return Boolean(readDb()[key]);
    }
    return false;
}

function recordBuilt(projectName, appNameSlug, meta = {}) {
    if (isDedupDisabled()) return;
    const key = makeKey(projectName, appNameSlug);
    if (!key.includes('|')) return;
    const db = readDb();
    db[key] = {
        projectName: (projectName || '').trim(),
        appNameSlug: (appNameSlug || '').trim(),
        builtAt: new Date().toISOString(),
        branchName: meta.branchName || null,
        s3Url: meta.s3Url || null,
    };
    writeDb(db);
}

module.exports = {
    wasAlreadyBuilt,
    recordBuilt,
    makeKey,
};
