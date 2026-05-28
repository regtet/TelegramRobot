/**
 * 解析 .env 中的布尔值：true / false（兼容 1/0、yes/no、on/off）
 * @param {string} name - 环境变量名
 * @param {boolean} defaultValue - 未设置或无法识别时的默认值
 */
function parseEnvBool(name, defaultValue = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') {
        return defaultValue;
    }
    const v = String(raw).trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') {
        return true;
    }
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') {
        return false;
    }
    return defaultValue;
}

module.exports = { parseEnvBool };
