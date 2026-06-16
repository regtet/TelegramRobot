/**
 * 统一的 JSON 持久化工具：读取容错 + 原子写入。
 *
 * 原子写入：先写同目录临时文件，再 rename 覆盖目标，避免写入中途崩溃/断电
 * 导致目标文件被截断成半个 JSON（下次解析失败 → 队列/配置丢失）。
 * Windows 与 POSIX 的 rename 均为「替换式」原子操作。
 */
const fs = require('fs');
const path = require('path');

/**
 * 读取并解析 JSON；文件不存在、为空或解析失败时返回 fallback。
 * 注意：不做结构校验（数组/对象），由调用方按需校验。
 * @template T
 * @param {string} file
 * @param {T} fallback
 * @returns {T}
 */
function readJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        const raw = fs.readFileSync(file, 'utf8').trim();
        if (!raw) return fallback;
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

/**
 * 原子写入 JSON。
 * @param {string} file
 * @param {*} data
 * @param {{ newline?: boolean, replacer?: ((key: string, value: any) => any)|null, space?: number }} [options]
 */
function writeJsonAtomic(file, data, options = {}) {
    const { newline = true, replacer = null, space = 2 } = options;
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });

    const json = JSON.stringify(data, replacer, space);
    const text = newline ? `${json}\n` : json;

    const tmp = path.join(
        dir,
        `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    try {
        fs.writeFileSync(tmp, text, 'utf8');
        fs.renameSync(tmp, file);
    } catch (err) {
        try {
            if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch {
            // 清理临时文件失败不影响主错误
        }
        throw err;
    }
}

/** bigint -> string，供含 bigint 字段的数据使用 */
function bigintReplacer(_key, value) {
    return typeof value === 'bigint' ? value.toString() : value;
}

module.exports = {
    readJson,
    writeJsonAtomic,
    bigintReplacer,
};
