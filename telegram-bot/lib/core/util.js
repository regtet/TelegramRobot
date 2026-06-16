/**
 * 通用工具：与运行时状态无关的纯函数（从 index.js 抽出）。
 */
const fs = require('fs');

/**
 * Promise 超时：避免某个请求/整链永久挂起占满并发槽。
 * 超时后 race 结束，但底层请求可能仍在进行（无法强制中止），仅释放调度等待。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms 超时毫秒；<=0 或非数值则不加超时直接返回原 promise
 * @param {string} [errLabel]
 * @returns {Promise<T>}
 */
async function withTimeout(promise, ms, errLabel) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) {
        return promise;
    }
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`${errLabel || '操作'}超时（>${Math.round(n / 1000)}s）`));
        }, n);
    });
    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** 分支名是否一致（去空白、不区分大小写，且两端均非空） */
function gitBranchMatches(actual, expected) {
    const a = (actual || '').trim().toLowerCase();
    const e = (expected || '').trim().toLowerCase();
    return Boolean(a && e && a === e);
}

/** 文件存在则删除；任何异常静默忽略 */
function tryUnlinkIfExists(filePath) {
    if (!filePath || typeof filePath !== 'string') return;
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
        // ignore
    }
}

module.exports = {
    withTimeout,
    gitBranchMatches,
    tryUnlinkIfExists,
};
