const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const DEFAULT_RAR_PATHS = [
    'C:\\Program Files\\WinRAR\\Rar.exe',
    'C:\\Program Files (x86)\\WinRAR\\Rar.exe',
];

/**
 * 解析 WinRAR 可执行文件路径（优先 RAR_COMMAND 环境变量）
 * @returns {string}
 */
function resolveRarExecutable() {
    const fromEnv = (process.env.RAR_COMMAND || '').trim();
    if (fromEnv && fs.existsSync(fromEnv)) {
        return fromEnv;
    }
    for (const candidate of DEFAULT_RAR_PATHS) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error(
        '未找到 WinRAR（Rar.exe）。请安装 WinRAR 或在 .env 设置 RAR_COMMAND=完整路径',
    );
}

/**
 * 使用 WinRAR 将 dist 打成 .rar（与手动「添加到压缩文件」默认选项一致）
 * @param {object} opts
 * @param {string} opts.distPath - dist 绝对路径
 * @param {string} opts.archiveFilePath - 输出 .rar 绝对路径
 * @param {string} [opts.cwd] - 执行目录（一般为项目根）
 */
async function packDistWithRar({
    distPath,
    archiveFilePath,
    cwd,
}) {
    const rarExe = resolveRarExecutable();

    if (fs.existsSync(archiveFilePath)) {
        fs.unlinkSync(archiveFilePath);
    }

    const distFolderName = path.basename(distPath);
    const args = ['a', '-r', '-y', archiveFilePath, distFolderName];

    const workDir = cwd || path.dirname(distPath);
    if (!fs.existsSync(path.join(workDir, distFolderName))) {
        throw new Error(`构建输出目录不存在: ${distPath}`);
    }

    await execFileAsync(rarExe, args, {
        cwd: workDir,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
    });

    if (!fs.existsSync(archiveFilePath)) {
        throw new Error(`RAR 打包完成但未生成文件: ${archiveFilePath}`);
    }

    const sizeMB = (fs.statSync(archiveFilePath).size / 1024 / 1024).toFixed(2);
    return { archiveFilePath, sizeMB };
}

module.exports = {
    resolveRarExecutable,
    packDistWithRar,
};
