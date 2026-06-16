/**
 * 统一提取错误信息：优先 error.message，否则字符串化。
 * @param {unknown} error
 * @returns {string}
 */
function errMsg(error) {
    if (!error) return String(error);
    if (typeof error === 'string') return error;
    return error.message || String(error);
}

module.exports = { errMsg };
