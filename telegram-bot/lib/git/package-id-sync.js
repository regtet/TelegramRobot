const chalk = require('chalk');
const { writePackageId } = require('../core/config-writer');

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 改 packageId 并提交推送（最多重试 3 次）
 * @param {import('../build/builder')} builder
 * @param {number} packageId
 * @returns {Promise<{ ok: boolean, skipped: boolean, error?: string }>}
 */
async function syncPackageIdWithGit(builder, packageId) {
    const writeResult = writePackageId(builder.projectPath, packageId);
    if (!writeResult.success) {
        return { ok: false, skipped: false, error: writeResult.error || '写入失败' };
    }
    if (!writeResult.changed) {
        return { ok: true, skipped: true };
    }

    const commitMsg = `update：分包ID ${packageId}`;
    let lastError = '';

    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
        const addResult = await builder.runCommand('git add src/config/config.js');
        if (!addResult.success) {
            lastError = addResult.error || 'git add 失败';
        } else {
            const commitResult = await builder.runCommand(
                `git commit -m ${JSON.stringify(commitMsg)}`,
            );
            if (!commitResult.success) {
                lastError = commitResult.error || 'git commit 失败';
            } else {
                const pushResult = await builder.runCommand('git push');
                if (pushResult.success) {
                    return { ok: true, skipped: false };
                }
                lastError = pushResult.error || 'git push 失败';
            }
        }

        if (attempt < RETRY_ATTEMPTS) {
            console.log(
                chalk.yellow(
                    `⚠ 分包同步第 ${attempt} 次失败，${RETRY_DELAY_MS / 1000}s 后重试: ${lastError}`,
                ),
            );
            await delay(RETRY_DELAY_MS);
        }
    }

    return { ok: false, skipped: false, error: lastError };
}

module.exports = {
    syncPackageIdWithGit,
    RETRY_ATTEMPTS,
};
