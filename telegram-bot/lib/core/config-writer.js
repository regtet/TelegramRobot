const fs = require('fs');
const path = require('path');

const PACKAGE_ID_REPLACE =
    /(packageId\s*:\s*)(\d+|['"][^'"]+['"])/;

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
};
