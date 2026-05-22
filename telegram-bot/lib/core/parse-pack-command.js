/**
 * 解析「打包」命令正文：支持多行、单行混写；可选「分包ID <数字>」。
 * @returns {{ branch: string, packageId: number|null }[]}
 */
function parsePackLine(line) {
    const tokens = String(line || '')
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0);
    const items = [];
    let i = 0;

    while (i < tokens.length) {
        const branch = tokens[i++];
        if (!branch) continue;

        let packageId = null;
        if (i < tokens.length && /^分包$/i.test(tokens[i]) && i + 1 < tokens.length && /^ID$/i.test(tokens[i + 1])) {
            i += 2;
            if (i < tokens.length && /^\d+$/.test(tokens[i])) {
                packageId = parseInt(tokens[i], 10);
                i += 1;
            }
        } else if (i < tokens.length && /^分包ID$/i.test(tokens[i])) {
            i += 1;
            if (i < tokens.length && /^\d+$/.test(tokens[i])) {
                packageId = parseInt(tokens[i], 10);
                i += 1;
            }
        }

        items.push({ branch, packageId });
    }

    return items;
}

/**
 * @param {string} trimmedText - 已 trim 的完整消息（以「打包」开头）
 */
function parsePackCommand(trimmedText) {
    let body = trimmedText.startsWith('打包') ? trimmedText.slice(2).trim() : trimmedText;
    if (!body) return [];

    const lines = body
        .split(/[\r\n]+/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

    const items = [];
    for (const line of lines) {
        items.push(...parsePackLine(line));
    }
    return items;
}

module.exports = {
    parsePackCommand,
    parsePackLine,
};
