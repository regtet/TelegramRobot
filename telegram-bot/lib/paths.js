/**
 * 单用户号项目：持久化数据与运行时目录统一在此定义。
 *
 * data/  — session、JSON 状态（apk-pending、打包历史、分支期望等）
 * var/   — 可再生的 logs / tmp / builds
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const VAR_DIR = path.join(ROOT, 'var');

const paths = {
    ROOT,
    DATA_DIR,
    VAR_DIR,
    envFile: path.join(ROOT, '.env'),
    sessionFile: path.join(DATA_DIR, 'session.txt'),
    apkPendingFile: path.join(DATA_DIR, 'apk-pending.json'),
    apkBuiltHistoryFile: path.join(DATA_DIR, 'apk-built-history.json'),
    branchPackageExpectFile: path.join(DATA_DIR, 'branch-package-expect.json'),
    branchListFile: path.join(DATA_DIR, 'branchList.json'),
    logsDir: path.join(VAR_DIR, 'logs'),
    tmpDir: path.join(VAR_DIR, 'tmp'),
    buildsDir: path.join(VAR_DIR, 'builds'),
};

function ensureDirs() {
    const dirs = [
        paths.DATA_DIR,
        paths.logsDir,
        paths.tmpDir,
        paths.buildsDir,
    ];
    for (const d of dirs) {
        if (!fs.existsSync(d)) {
            fs.mkdirSync(d, { recursive: true });
        }
    }
}

function migrateFile(legacyName, targetPath) {
    const legacy = path.join(ROOT, legacyName);
    if (!fs.existsSync(legacy) || !fs.statSync(legacy).isFile()) {
        return;
    }
    if (fs.existsSync(targetPath)) {
        return;
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.renameSync(legacy, targetPath);
    console.log(`[paths] 已迁移 ${legacyName} → ${path.relative(ROOT, targetPath)}`);
}

function migrateDir(legacyName, targetDir) {
    const legacy = path.join(ROOT, legacyName);
    if (!fs.existsSync(legacy) || !fs.statSync(legacy).isDirectory()) {
        return;
    }
    fs.mkdirSync(targetDir, { recursive: true });
    for (const name of fs.readdirSync(legacy)) {
        const from = path.join(legacy, name);
        const to = path.join(targetDir, name);
        if (!fs.existsSync(to)) {
            fs.renameSync(from, to);
        }
    }
    try {
        const left = fs.readdirSync(legacy);
        if (left.length === 0) {
            fs.rmdirSync(legacy);
            console.log(`[paths] 已迁移目录 ${legacyName}/ → ${path.relative(ROOT, targetDir)}/`);
        }
    } catch {
        // 非空目录保留，避免误删用户文件
    }
}

/** 从旧版根目录布局迁移到 data/ + var/（仅当新路径不存在时移动） */
function migrateLegacyLayout() {
    ensureDirs();
    migrateFile('session.txt', paths.sessionFile);
    migrateFile('apk-pending.json', paths.apkPendingFile);
    migrateFile('apk-built-history.json', paths.apkBuiltHistoryFile);
    migrateFile('branch-package-expect.json', paths.branchPackageExpectFile);
    migrateFile('branchList.json', paths.branchListFile);
    migrateFile('zip-analyze-pending.json', path.join(DATA_DIR, 'zip-analyze-pending.json'));
    migrateDir('logs', paths.logsDir);
    migrateDir('tmp', paths.tmpDir);
    migrateDir('builds', paths.buildsDir);
}

module.exports = {
    ...paths,
    ensureDirs,
    migrateLegacyLayout,
};
