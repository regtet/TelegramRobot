const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

/**
 * 从压缩包文件名提取分支名
 * 支持格式: w1-boypg.zip, w1-boypg.com.zip, w1-boypg.rar 等
 * @param {string} fileName - 文件名
 * @returns {string|null} - 提取的分支名，失败返回 null
 */
function extractBranchNameFromFileName(fileName) {
    if (!fileName) return null;

    // 支持的压缩包扩展名
    const archiveExtensions = ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2'];

    // 首先检查是否是压缩包文件，如果不是直接返回 null
    const lowerFileName = fileName.toLowerCase();
    let isArchive = false;
    let matchedExt = '';

    for (const ext of archiveExtensions) {
        if (lowerFileName.endsWith(ext)) {
            isArchive = true;
            matchedExt = ext;
            break;
        }
    }

    // 如果不是压缩包文件，直接返回 null
    if (!isArchive) {
        return null;
    }

    // 移除扩展名
    let nameWithoutExt = fileName.slice(0, -matchedExt.length);

    // 处理 .com.zip 这种情况（移除 .com 后缀）
    if (nameWithoutExt.endsWith('.com')) {
        nameWithoutExt = nameWithoutExt.slice(0, -4);
    }

    // 验证分支名格式（只包含字母、数字、连字符、下划线、点）
    if (!/^[a-zA-Z0-9\-_\.]+$/.test(nameWithoutExt)) {
        return null;
    }

    return nameWithoutExt;
}

/** 从 config 中的完整 URL 提取主机名（小写、无端口） */
function hostFromConfigUrl(url) {
    const m = String(url || '').match(/^https?:\/\/([^\/#'"?]+)/i);
    if (!m || !m[1]) return '';
    return m[1].split(':')[0].toLowerCase();
}

/**
 * 是否为「二级域名」（子域）：去掉 www. 后仍多于根域两段，如 motogp.wgwg777.com
 * wg-motogp.com / wgmotogp.com 仅两段，不算。
 */
function isSubdomainHost(host) {
    const h = (host || '').replace(/^www\./i, '');
    const labels = h.split('.').filter(Boolean);
    return labels.length > 2;
}

/** proxyShareUrlList 中用于 APK web_url：有子域则取列表顺序中第一个子域 URL，否则取第一项 */
function pickPrimaryDomainFromProxyUrls(proxyUrls) {
    if (!Array.isArray(proxyUrls) || proxyUrls.length === 0) return null;
    const subdomainUrl = proxyUrls.find((url) => {
        const host = hostFromConfigUrl(url);
        return host && isSubdomainHost(host);
    });
    return subdomainUrl || proxyUrls[0];
}

/**
 * 读取指定分支的 config.js 文件并提取
 * - packageId
 * - debug
 * - appDownPath 的 app 文件名及中间的 slug
 * - proxyShareUrlList：优先子域 URL，否则第一项（用于生成 web_url）
 * - 反解析出来的主域名 / 备用域名列表（与 0.html 工具生成规则相反向）
 * @param {string} projectPath - 项目路径
 * @param {string} branchName - 分支名
 * @returns {Promise<{
 *   success: boolean,
 *   packageId?: number|string,
 *   debug?: boolean,
 *   appName?: string,
 *   appNameSlug?: string,
 *   primaryDomain?: string,
 *   mainDomains?: string[],
 *   backupDomains?: { domain: string, hidePhone: boolean }[],
 *   error?: string
 * }>}
 */
async function readPackageIdFromBranch(projectPath, branchName) {
    const configPath = path.join(projectPath, 'src', 'config', 'config.js');

    try {
        // 检查文件是否存在
        if (!fs.existsSync(configPath)) {
            return {
                success: false,
                error: '配置文件不存在'
            };
        }

        // 读取文件内容
        const fileContent = fs.readFileSync(configPath, 'utf8');

        let packageId = null;
        let debug = null;
        let appName = null;
        let appNameSlug = null;
        let primaryDomain = null;
        let mainDomains = [];
        let backupDomains = [];

        // 尝试解析 packageId
        const packageIdPatterns = [
            /packageId\s*:\s*(\d+)/,           // packageId: 14
            /packageId\s*:\s*['"]([^'"]+)['"]/, // packageId: '14'
            /packageId\s*=\s*(\d+)/,          // packageId = 14
            /packageId\s*=\s*['"]([^'"]+)['"]/, // packageId = '14'
            /["']packageId["']\s*:\s*(\d+)/,   // "packageId": 14
            /["']packageId["']\s*:\s*['"]([^'"]+)['"]/, // "packageId": "14"
        ];

        for (const pattern of packageIdPatterns) {
            const match = fileContent.match(pattern);
            if (match && match[1]) {
                const packageIdStr = match[1];
                // 如果是数字字符串，尝试转换为数字
                const numPackageId = parseInt(packageIdStr, 10);
                packageId = isNaN(numPackageId) ? packageIdStr : numPackageId;
                break;
            }
        }

        // 尝试解析 debug
        const debugPatterns = [
            /debug\s*:\s*(true|false)/,        // debug: true 或 debug: false
            /debug\s*=\s*(true|false)/,         // debug = true 或 debug = false
            /["']debug["']\s*:\s*(true|false)/, // "debug": true 或 "debug": false
        ];

        for (const pattern of debugPatterns) {
            const match = fileContent.match(pattern);
            if (match && match[1]) {
                debug = match[1] === 'true';
                break;
            }
        }

        // 尝试解析 appDownPath 的 app 名称
        const appPathPatterns = [
            /appDownPath\s*:\s*['"]([^'"]+)['"]/,
            /["']appDownPath["']\s*:\s*['"]([^'"]+)['"]/,
        ];

        for (const pattern of appPathPatterns) {
            const match = fileContent.match(pattern);
            if (match && match[1]) {
                const fullPath = match[1];
                const parts = fullPath.split('/');
                if (parts.length > 0) {
                    appName = parts[parts.length - 1]; // 取最后一段，如 app-522luck.apk
                } else {
                    appName = fullPath;
                }

                if (appName) {
                    const m = appName.match(/^app-(.+)\.apk$/i);
                    if (m && m[1]) {
                        appNameSlug = m[1]; // 例如 522luck
                    }
                }
                break;
            }
        }

        // 尝试解析 proxyShareUrlList（主域名列表）
        const proxySectionMatch = fileContent.match(/proxyShareUrlList\s*:\s*\[([\s\S]*?)\]/);
        if (proxySectionMatch && proxySectionMatch[1]) {
            const section = proxySectionMatch[1];
            const proxyUrls = [];
            const fullUrlRegex = /['"](https?:\/\/[^'"]+)['"]/g;
            let fullM;
            while ((fullM = fullUrlRegex.exec(section)) !== null) {
                if (fullM[1]) proxyUrls.push(fullM[1]);
            }

            const domainSet = new Set();
            for (const url of proxyUrls) {
                const host = hostFromConfigUrl(url);
                if (!host) continue;
                const base = host.replace(/^www\./i, '');
                domainSet.add(base);
            }

            mainDomains = Array.from(domainSet);
            primaryDomain = pickPrimaryDomainFromProxyUrls(proxyUrls);
        }

        // 尝试解析 independentUrlList（备用域名列表，phone=true 显示手机号）
        const indepSectionMatch = fileContent.match(/independentUrlList\s*:\s*\[([\s\S]*?)\]/);
        if (indepSectionMatch && indepSectionMatch[1]) {
            const section = indepSectionMatch[1];
            const objRegex = /\{[^}]*\}/g;
            const map = new Map(); // domain(去掉www) -> { domain, phone }
            let m;

            while ((m = objRegex.exec(section)) !== null) {
                const objText = m[0];
                const urlMatch = objText.match(/url\s*:\s*['"]([^'"]+)['"]/);
                const phoneMatch = objText.match(/phone\s*:\s*(true|false)/i);
                if (!urlMatch || !phoneMatch) continue;

                const fullUrl = urlMatch[1];
                const hostMatch = fullUrl.match(/^https?:\/\/([^\/'"]+)/i);
                if (!hostMatch || !hostMatch[1]) continue;
                const host = hostMatch[1].trim();
                if (!host) continue;

                const domainKey = host.replace(/^www\./i, '');
                const phone = phoneMatch[1].toLowerCase() === 'true';

                if (map.has(domainKey)) {
                    const existing = map.get(domainKey);
                    // 只要有一个为 false，则视为整体 phone=false（隐藏手机号优先）
                    map.set(domainKey, { domain: domainKey, phone: existing.phone && phone });
                } else {
                    map.set(domainKey, { domain: domainKey, phone });
                }
            }

            backupDomains = Array.from(map.values()).map(item => ({
                domain: item.domain,
                hidePhone: !item.phone
            }));
        }

        // 如果至少找到了 packageId，就返回成功
        if (packageId !== null) {
            return {
                success: true,
                packageId: packageId,
                debug: debug !== null ? debug : undefined,
                appName: appName || undefined,
                appNameSlug: appNameSlug || undefined,
                primaryDomain: primaryDomain || undefined,
                mainDomains: mainDomains.length > 0 ? mainDomains : undefined,
                backupDomains: backupDomains.length > 0 ? backupDomains : undefined
            };
        }

        // 如果所有模式都匹配不到，返回未找到
        return {
            success: false,
            error: '未找到 packageId 配置'
        };

    } catch (error) {
        console.error(chalk.red(`读取配置文件失败: ${error.message}`));
        return {
            success: false,
            error: `读取失败: ${error.message}`
        };
    }
}

module.exports = {
    extractBranchNameFromFileName,
    readPackageIdFromBranch,
    hostFromConfigUrl,
    isSubdomainHost,
    pickPrimaryDomainFromProxyUrls,
};
