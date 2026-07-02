const fs = require('fs');
const path = require('path');

const PACKAGE_ID_REPLACE =
    /(packageId\s*:\s*)(\d+|['"][^'"]+['"])/;
const DEBUG_REPLACE = /(debug\s*:\s*)(true|false)/;
const LOCALHOST_LINE_RE = /^\s*['"]localhost['"]\s*:\s*['"]([^'"]+)['"]\s*,?\s*$/;
const LIST_ENTRY_RE = /['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g;
const SERVER_CONFIG_IMPORT_RE = /import\s+config\s+from\s+['"]\.\/config['"]/;

function escapeRegExp(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeDomainInput(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    let host = s
        .replace(/^https?:\/\//i, '')
        .replace(/^\/+|\/+$/g, '')
        .split('/')[0]
        .split('?')[0]
        .split('#')[0]
        .trim()
        .toLowerCase();
    host = host.replace(/^www\./i, '');
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
        return null;
    }
    return host;
}

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

function readConfigFile(projectPath) {
    const configPath = path.join(projectPath, 'src', 'config', 'config.js');
    if (!fs.existsSync(configPath)) {
        return { success: false, error: 'config.js 不存在' };
    }
    return { success: true, path: configPath, content: fs.readFileSync(configPath, 'utf8') };
}

function formatUrlPairsForList(urls, indent = '        ') {
    const pairs = [];
    for (let i = 0; i < urls.length; i += 2) {
        const left = urls[i];
        const right = urls[i + 1];
        if (left && right) {
            pairs.push(`${indent}'${left}', '${right}'`);
        } else if (left) {
            pairs.push(`${indent}'${left}'`);
        }
    }
    return pairs.join(',\n');
}

function upsertMainDomainInConfig(projectPath, domain) {
    const normalized = normalizeDomainInput(domain);
    if (!normalized) return { success: false, changed: false, error: '域名格式无效' };
    const r = readConfigFile(projectPath);
    if (!r.success) return { success: false, changed: false, error: r.error };
    const sectionMatch = r.content.match(/proxyShareUrlList\s*:\s*\[([\s\S]*?)\]/);
    if (!sectionMatch) {
        return { success: false, changed: false, error: '未找到 proxyShareUrlList 字段' };
    }

    const urls = [];
    const urlRe = /['"](https?:\/\/[^'"]+)['"]/g;
    let m;
    while ((m = urlRe.exec(sectionMatch[1])) !== null) {
        if (m[1]) urls.push(m[1].trim());
    }

    const hasBase = urls.some((u) => new RegExp(`^https?:\\/\\/(www\\.)?${escapeRegExp(normalized)}$`, 'i').test(u));
    if (hasBase) return { success: true, changed: false, normalizedDomain: normalized };

    urls.push(`https://${normalized}`, `https://www.${normalized}`);
    const unique = [];
    const seen = new Set();
    for (const u of urls) {
        const key = u.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(u);
    }

    const rebuilt =
        `proxyShareUrlList: [\n` +
        `${formatUrlPairsForList(unique)}\n` +
        `    ]`;
    const next = r.content.replace(/proxyShareUrlList\s*:\s*\[[\s\S]*?\]/, rebuilt);
    if (next === r.content) return { success: true, changed: false, normalizedDomain: normalized };
    fs.writeFileSync(r.path, next, 'utf8');
    return { success: true, changed: true, normalizedDomain: normalized };
}

function upsertBackupDomainInConfig(projectPath, domain) {
    const normalized = normalizeDomainInput(domain);
    if (!normalized) return { success: false, changed: false, error: '域名格式无效' };
    const r = readConfigFile(projectPath);
    if (!r.success) return { success: false, changed: false, error: r.error };
    const sectionMatch = r.content.match(/independentUrlList\s*:\s*\[([\s\S]*?)\]/);
    if (!sectionMatch) {
        return { success: false, changed: false, error: '未找到 independentUrlList 字段' };
    }

    const objRe = /\{[^}]*\}/g;
    const domainToPhone = new Map();
    let m;
    while ((m = objRe.exec(sectionMatch[1])) !== null) {
        const obj = m[0];
        const urlMatch = obj.match(/url\s*:\s*['"]https?:\/\/([^'"/]+)['"]/i);
        const phoneMatch = obj.match(/phone\s*:\s*(true|false)/i);
        if (!urlMatch || !urlMatch[1]) continue;
        const host = String(urlMatch[1]).toLowerCase().replace(/^www\./, '');
        const phone = phoneMatch ? phoneMatch[1].toLowerCase() === 'true' : true;
        if (domainToPhone.has(host)) {
            domainToPhone.set(host, domainToPhone.get(host) && phone);
        } else {
            domainToPhone.set(host, phone);
        }
    }

    if (domainToPhone.has(normalized)) {
        return { success: true, changed: false, normalizedDomain: normalized };
    }
    domainToPhone.set(normalized, true);

    const pairLines = [];
    for (const [d, phone] of domainToPhone.entries()) {
        pairLines.push(
            `        { url: 'https://${d}', phone: ${phone ? 'true' : 'false'} }, { url: 'https://www.${d}', phone: ${phone ? 'true' : 'false'} }`,
        );
    }
    const rebuilt =
        `independentUrlList: [\n` +
        `${pairLines.join(',\n')}\n` +
        `    ]`;
    const next = r.content.replace(/independentUrlList\s*:\s*\[[\s\S]*?\]/, rebuilt);
    if (next === r.content) return { success: true, changed: false, normalizedDomain: normalized };
    fs.writeFileSync(r.path, next, 'utf8');
    return { success: true, changed: true, normalizedDomain: normalized };
}

function upsertServerDomain(projectPath, domain) {
    const normalized = normalizeDomainInput(domain);
    if (!normalized) return { success: false, changed: false, error: '域名格式无效' };
    const serverPath = path.join(projectPath, 'src', 'config', 'server.js');
    if (!fs.existsSync(serverPath)) {
        return { success: false, changed: false, error: 'server.js 不存在' };
    }
    const content = fs.readFileSync(serverPath, 'utf8');
    const listsBlock = extractServerListsInner(content);
    if (!listsBlock) {
        return { success: false, changed: false, error: 'server.js 未找到 lists 配置' };
    }

    const inner = listsBlock.inner;
    const hasBase = new RegExp(`['"]${escapeRegExp(normalized)}['"]\\s*:`, 'i').test(inner);
    const hasWww = new RegExp(`['"]www\\.${escapeRegExp(normalized)}['"]\\s*:`, 'i').test(inner);
    if (hasBase && hasWww) return { success: true, changed: false, normalizedDomain: normalized };

    const lines = inner.split('\n');
    const keyLine = lines.find((l) => /:\s*['"]wss:\/\//.test(l));
    const indent = (keyLine && keyLine.match(/^\s*/)?.[0]) || '        ';
    const appendLines = [];
    const wss = `wss://server.${normalized}`;
    if (!hasBase) appendLines.push(`${indent}'${normalized}': '${wss}',`);
    if (!hasWww) appendLines.push(`${indent}'www.${normalized}': '${wss}',`);
    if (appendLines.length === 0) return { success: true, changed: false, normalizedDomain: normalized };

    let insertAt = lines.findIndex((l) => /['"]localhost['"]\s*:/.test(l));
    if (insertAt < 0) insertAt = lines.findIndex((l) => /['"]debug['"]\s*:/.test(l));
    if (insertAt < 0) insertAt = lines.length;
    lines.splice(insertAt, 0, ...appendLines, '');

    const newInner = lines.join('\n');
    const next = `${content.slice(0, listsBlock.openBrace + 1)}${newInner}${content.slice(listsBlock.closeBrace)}`;
    fs.writeFileSync(serverPath, next, 'utf8');
    return { success: true, changed: true, normalizedDomain: normalized };
}

function applyDomainUpdate(projectPath, { domain, backup = false } = {}) {
    const configResult = backup
        ? upsertBackupDomainInConfig(projectPath, domain)
        : upsertMainDomainInConfig(projectPath, domain);
    if (!configResult.success) return configResult;

    const serverResult = upsertServerDomain(projectPath, configResult.normalizedDomain || domain);
    if (!serverResult.success) return serverResult;

    return {
        success: true,
        changed: Boolean(configResult.changed || serverResult.changed),
        configChanged: Boolean(configResult.changed),
        serverChanged: Boolean(serverResult.changed),
        normalizedDomain: configResult.normalizedDomain || serverResult.normalizedDomain || null,
    };
}

module.exports = {
    writePackageId,
    fixDebugMode,
    fixServerLocalhostDuplicates,
    applyProjectConfigFixes,
    normalizeDomainInput,
    applyDomainUpdate,
};
