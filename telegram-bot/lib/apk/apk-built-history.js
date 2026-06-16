const { parseEnvBool } = require('../core/env-bool');
const { readJson, writeJsonAtomic } = require('../core/json-store');

const { apkBuiltHistoryFile: DATA_FILE } = require('../paths');

function readDb() {
    const data = readJson(DATA_FILE, {});
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function writeDb(data) {
    writeJsonAtomic(DATA_FILE, data);
}

function makeKey(projectName, appNameSlug) {
    const p = (projectName || '').trim();
    const s = (appNameSlug || '').trim().toLowerCase();
    return `${p}|${s}`;
}

function isDedupDisabled() {
    return !parseEnvBool('APK_SKIP_IF_ALREADY_BUILT', true);
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
