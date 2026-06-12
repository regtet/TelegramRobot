const fs = require('fs');
const path = require('path');

const PACKAGE_ID_REPLACE =
    /(packageId\s*:\s*)(\d+|['"][^'"]+['"])/;
const DEBUG_REPLACE = /(debug\s*:\s*)(true|false)/;
const LOCALHOST_LINE_RE = /^\s*['"]localhost['"]\s*:\s*['"]([^'"]+)['"]\s*,?\s*$/;
const LIST_ENTRY_RE = /['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g;
const SERVER_CONFIG_IMPORT_RE = /import\s+config\s+from\s+['"]\.\/config['"]/;

/**
 * 从 server.js 源码中提取 lists 对象内部文本
 */
function extractServerListsInner(content) {
    const listsIdx = content.search(/\blists\s*:/);
    if (listsIdx === -1) return null;

    const openBrace = content.indexOf('{', listsIdx);
    if (openBrace === -1) return null;

    let depth = 0;
    for (let i = openBrace; i < content.length; i++) {
        const ch = content[i];
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                return {
                    openBrace,
                    closeBrace: i,
                    inner: content.slice(openBrace + 1, i),
                };
            }
        }
    }
    return null;
}

/**
 * 获取 lists 中第一个业务域名及其 wss 地址（跳过 localhost / debug / www.*）
 */
function getFirstDomainWssFromListsInner(listsInner) {
    const entries = [];
    let match;
    LIST_ENTRY_RE.lastIndex = 0;
    while ((match = LIST_ENTRY_RE.exec(listsInner)) !== null) {
        entries.push({ key: match[1], value: match[2] });
    }

    const firstDomain = entries.find(
        (entry) =>
            entry.key !== 'localhost' &&
            entry.key !== 'debug' &&
            !/^www\./i.test(entry.key),
    );
    return firstDomain ? firstDomain.value : null;
}

/**
 * 修复 server.js 中重复的 localhost 配置，保留与首个域名对应的 wss
 * @returns {{ success: boolean, changed: boolean, error?: string, details?: string[] }}
 */
function fixServerLocalhostDuplicates(projectPath) {
    const serverPath = path.join(projectPath, 'src', 'config', 'server.js');

    try {
        if (!fs.existsSync(serverPath)) {
            return { success: true, changed: false };
        }

        const content = fs.readFileSync(serverPath, 'utf8');
        if (!SERVER_CONFIG_IMPORT_RE.test(content)) {
            return { success: true, changed: false };
        }

        const listsBlock = extractServerListsInner(content);
        if (!listsBlock) {
            return { success: false, changed: false, error: 'server.js 未找到 lists 配置' };
        }

        const expectedWss = getFirstDomainWssFromListsInner(listsBlock.inner);
        if (!expectedWss) {
            return { success: true, changed: false };
        }

        const lines = listsBlock.inner.split('\n');
        const localhostLines = [];
        for (let i = 0; i < lines.length; i++) {
            const lineMatch = lines[i].match(LOCALHOST_LINE_RE);
            if (lineMatch) {
                localhostLines.push({ index: i, value: lineMatch[1] });
            }
        }

        if (localhostLines.length <= 1) {
            return { success: true, changed: false };
        }

        const details = [];
        const newLines = lines.filter((line, i) => {
            const lineMatch = line.match(LOCALHOST_LINE_RE);
            if (!lineMatch) return true;
            if (lineMatch[1] === expectedWss) return true;
            details.push(`移除测试 localhost: ${lineMatch[1]}`);
            return false;
        });

        if (newLines.length === lines.length) {
            return { success: true, changed: false };
        }

        if (!newLines.some((line) => LOCALHOST_LINE_RE.test(line))) {
            const indent = (lines[localhostLines[0].index].match(/^\s*/) || ['        '])[0];
            const insertAt = newLines.findIndex((line) => /['"]debug['"]\s*:/.test(line));
            const localhostLine = `${indent}'localhost': '${expectedWss}',`;
            if (insertAt >= 0) {
                newLines.splice(insertAt, 0, localhostLine);
            } else {
                newLines.push(localhostLine);
            }
            details.push(`补回 localhost: ${expectedWss}`);
        }

        const newInner = newLines.join('\n');
        const next = `${content.slice(0, listsBlock.openBrace + 1)}${newInner}${content.slice(listsBlock.closeBrace)}`;
        fs.writeFileSync(serverPath, next, 'utf8');

        return { success: true, changed: true, details };
    } catch (error) {
        return { success: false, changed: false, error: error.message };
    }
}

/**
 * 将 config.js 中的 debug 强制设为 false（打包前正式服）
 * @returns {{ success: boolean, changed: boolean, error?: string, previous?: boolean }}
 */
function fixDebugMode(projectPath) {
    const configPath = path.join(projectPath, 'src', 'config', 'config.js');

    try {
        if (!fs.existsSync(configPath)) {
            return { success: true, changed: false };
        }

        const content = fs.readFileSync(configPath, 'utf8');
        const match = content.match(/debug\s*:\s*(true|false)/);
        if (!match) {
            return { success: true, changed: false };
        }

        if (match[1] === 'false') {
            return { success: true, changed: false, previous: false };
        }

        if (!DEBUG_REPLACE.test(content)) {
            return { success: false, changed: false, error: '无法替换 debug 字段' };
        }

        const next = content.replace(DEBUG_REPLACE, '$1false');
        fs.writeFileSync(configPath, next, 'utf8');

        return {
            success: true,
            changed: true,
            previous: match[1] === 'true',
        };
    } catch (error) {
        return { success: false, changed: false, error: error.message };
    }
}

/**
 * 打包前修正 config.js / server.js 配置
 */
function applyProjectConfigFixes(projectPath) {
    const debugResult = fixDebugMode(projectPath);
    if (!debugResult.success) {
        return debugResult;
    }

    const serverResult = fixServerLocalhostDuplicates(projectPath);
    if (!serverResult.success) {
        return serverResult;
    }

    const details = [];
    if (debugResult.changed) {
        details.push(`debug: ${debugResult.previous} → false`);
    }
    if (serverResult.details && serverResult.details.length > 0) {
        details.push(...serverResult.details);
    }

    return {
        success: true,
        changed: Boolean(debugResult.changed || serverResult.changed),
        configChanged: Boolean(debugResult.changed),
        serverChanged: Boolean(serverResult.changed),
        details,
    };
}

/**
 * 写入 src/config/config.js 中的 packageId
 * @returns {{ success: boolean, changed: boolean, previous?: number|string, error?: string }}
 */
function writePackageId(projectPath, newPackageId) {
    const configPath = path.join(projectPath, 'src', 'config', 'config.js');

    try {
        if (!fs.existsSync(configPath)) {
            return { success: false, changed: false, error: '配置文件不存在' };
        }

        const content = fs.readFileSync(configPath, 'utf8');
        const match = content.match(/packageId\s*:\s*(\d+|['"][^'"]+['"])/);
        if (!match) {
            return { success: false, changed: false, error: '未找到 packageId 字段' };
        }

        const prevRaw = match[1];
        const prevNum = parseInt(String(prevRaw).replace(/['"]/g, ''), 10);
        const target = Number(newPackageId);
        if (!Number.isFinite(target)) {
            return { success: false, changed: false, error: '无效的分包 ID' };
        }

        if (!Number.isNaN(prevNum) && prevNum === target) {
            return { success: true, changed: false, previous: prevNum };
        }

        if (!PACKAGE_ID_REPLACE.test(content)) {
            return { success: false, changed: false, error: '无法替换 packageId' };
        }

        const next = content.replace(PACKAGE_ID_REPLACE, `$1${target}`);
        fs.writeFileSync(configPath, next, 'utf8');

        return {
            success: true,
            changed: true,
            previous: Number.isNaN(prevNum) ? prevRaw : prevNum,
        };
    } catch (error) {
        return { success: false, changed: false, error: error.message };
    }
}

module.exports = {
    writePackageId,
    fixDebugMode,
    fixServerLocalhostDuplicates,
    applyProjectConfigFixes,
};
