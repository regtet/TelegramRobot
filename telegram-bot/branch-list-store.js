const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'branchList.json');

function ensureDataShape(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return {};
    }
    return data;
}

function readData() {
    if (!fs.existsSync(DATA_FILE)) {
        return {};
    }

    const raw = fs.readFileSync(DATA_FILE, 'utf8').trim();
    if (!raw) {
        return {};
    }

    try {
        const parsed = JSON.parse(raw);
        return ensureDataShape(parsed);
    } catch (error) {
        throw new Error(`branchList.json 解析失败: ${error.message}`);
    }
}

function writeData(data) {
    const safeData = ensureDataShape(data);
    fs.writeFileSync(DATA_FILE, `${JSON.stringify(safeData, null, 2)}\n`, 'utf8');
}

function normalizeKey(value) {
    return (value || '').trim().toUpperCase();
}

/** 按不区分大小写匹配 JSON 里的真实 key（如 888Equipe vs 888EQUIPE） */
function resolveCanonicalKey(data, rawKey) {
    const norm = normalizeKey(rawKey);
    if (!norm) return null;
    for (const k of Object.keys(data)) {
        if (normalizeKey(k) === norm) return k;
    }
    return null;
}

function parseCommand(text) {
    const parts = (text || '').trim().split(/\s+/).filter(Boolean);
    // 群内常带 /cmd@BotUsername，需去掉 @ 后缀才能匹配 /list /get 等
    const rawFirst = parts[0] || '';
    const command = rawFirst.split('@')[0].toLowerCase();
    const args = parts.slice(1);
    return { command, args };
}

function formatOneLine(key, item) {
    const timeText = Array.isArray(item.time) && item.time.length > 0
        ? ` | 预计发布时间: ${item.time.map(formatTimeToken).join('、')}`
        : '';
    return `${key}: ${item.branch} (${item.desc})${timeText}`;
}

function normalizeTimes(values) {
    if (!Array.isArray(values) || values.length === 0) {
        return [];
    }
    return values.map((value) => value.trim()).filter(Boolean);
}

function isValidTimeToken(token) {
    // 支持: 5 / 6 / 10.30（小时或小时.分钟）
    return /^\d{1,2}(\.\d{1,2})?$/.test(token);
}

function formatTimeToken(token) {
    const normalized = String(token || '').trim();
    if (!normalized.includes('.')) {
        return `${normalized}点`;
    }
    const [hour, minute] = normalized.split('.');
    return `${hour}点${minute}分`;
}

function handleCommand(text) {
    const { command, args } = parseCommand(text);

    if (!['/list', '/get', '/set', '/add', '/del'].includes(command)) {
        return '';
    }

    const data = readData();

    if (command === '/list') {
        const keys = Object.keys(data).sort();
        if (keys.length === 0) {
            return '暂无数据';
        }
        const maxKeyLength = keys.reduce((max, key) => Math.max(max, `${key}系列`.length), 0);
        const lines = keys.map((key) => {
            const paddedKey = `${key}系列`.padEnd(maxKeyLength, ' ');
            const item = data[key];
            const timeText = Array.isArray(item.time) && item.time.length > 0
                ? ` (预计发布时间: ${item.time.map(formatTimeToken).join('、')})`
                : '';
            return `${paddedKey} -> ${item.branch}${timeText}`;
        });
        return `📦 当前系列最新分支列表：\n\n${lines.join('\n')}\n\n共 ${keys.length} 个系列`;
    }

    if (command === '/get') {
        if (args.length === 0) {
            return '用法: /get AJ KF';
        }
        const lines = args.map((raw) => {
            const canonical = resolveCanonicalKey(data, raw);
            const item = canonical ? data[canonical] : null;
            return item ? formatOneLine(canonical, item) : `${normalizeKey(raw)}: 不存在`;
        });
        return lines.join('\n');
    }

    if (command === '/set') {
        if (args.length < 2) {
            return '用法: /set AJ 分支名 [时间...]';
        }
        const canonicalKey = resolveCanonicalKey(data, args[0]);
        const newBranch = (args[1] || '').trim();
        const times = normalizeTimes(args.slice(2));

        if (!newBranch) {
            return '参数无效';
        }
        if (times.some((token) => !isValidTimeToken(token))) {
            return '时间格式无效，仅支持如: 5 6 10.30';
        }
        if (!canonicalKey) {
            return `${normalizeKey(args[0])}: 不存在，无法修改`;
        }

        data[canonicalKey].branch = newBranch;
        if (times.length > 0) {
            data[canonicalKey].time = times;
        } else {
            delete data[canonicalKey].time;
        }
        writeData(data);
        const timeText = times.length > 0 ? ` | 预计发布时间: ${times.map(formatTimeToken).join('、')}` : '';
        return `已修改 ${canonicalKey}: ${newBranch}${timeText}`;
    }

    if (command === '/add') {
        if (args.length < 2) {
            return '用法: /add AJ 分支名 [时间...]';
        }
        const key = normalizeKey(args[0]);
        const branch = (args[1] || '').trim();
        const times = normalizeTimes(args.slice(2));

        if (!key || !branch) {
            return '参数无效';
        }
        if (times.some((token) => !isValidTimeToken(token))) {
            return '时间格式无效，仅支持如: 5 6 10.30';
        }
        if (resolveCanonicalKey(data, args[0])) {
            return `${key}: 已存在，新增失败`;
        }

        data[key] = { branch, desc: `${key}系列` };
        if (times.length > 0) {
            data[key].time = times;
        }
        writeData(data);
        const timeText = times.length > 0 ? ` | 预计发布时间: ${times.map(formatTimeToken).join('、')}` : '';
        return `已新增 ${key}系列: ${branch}${timeText}`;
    }

    if (args.length !== 1) {
        return '用法: /del AJ';
    }

    const canonicalKey = resolveCanonicalKey(data, args[0]);
    if (!canonicalKey) {
        return `${normalizeKey(args[0])}: 不存在，删除失败`;
    }

    delete data[canonicalKey];
    writeData(data);
    return `已删除 ${canonicalKey}`;
}

module.exports = {
    readData,
    writeData,
    handleCommand,
};
