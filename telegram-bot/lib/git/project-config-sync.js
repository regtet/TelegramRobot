const chalk = require('chalk');
const { applyProjectConfigFixes } = require('../core/config-writer');
const { RETRY_ATTEMPTS, RETRY_DELAY_MS, delay } = require('./package-id-sync');

const COMMIT_MSG = '项目配置修改';

/**
 * 打包前修正 debug / server.js localhost 并提交推送
 * @param {import('../build/builder')} builder
 * @returns {Promise<{ ok: boolean, skipped: boolean, error?: string, details?: string[] }>}
 */
async function syncProjectConfigWithGit(builder) {
    const fixResult = applyProjectConfigFixes(builder.projectPath);
    if (!fixResult.success) {
        return { ok: false, skipped: false, error: fixResult.error || '配置修正失败' };
    }
    if (!fixResult.changed) {
        return { ok: true, skipped: true };
    }

    const filesToAdd = [];
    if (fixResult.configChanged) filesToAdd.push('src/config/config.js');
    if (fixResult.serverChanged) filesToAdd.push('src/config/server.js');

    let lastError = '';

    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
        const addResult = await builder.runCommand(`git add ${filesToAdd.join(' ')}`);
        if (!addResult.success) {
            lastError = addResult.error || 'git add 失败';
        } else {
            const commitResult = await builder.runCommand(
                `git commit -m ${JSON.stringify(COMMIT_MSG)}`,
            );
            if (!commitResult.success) {
                lastError = commitResult.error || 'git commit 失败';
            } else {
                const pushResult = await builder.runCommand('git push');
                if (pushResult.success) {
                    return {
                        ok: true,
                        skipped: false,
                        details: fixResult.details,
                    };
                }
                lastError = pushResult.error || 'git push 失败';
            }
        }

        if (attempt < RETRY_ATTEMPTS) {
            console.log(
                chalk.yellow(
                    `⚠ 项目配置同步第 ${attempt} 次失败，3s 后重试: ${lastError}`,
                ),
            );
            await delay(RETRY_DELAY_MS);
        }
    }

    return { ok: false, skipped: false, error: lastError };
}

module.exports = {
    syncProjectConfigWithGit,
};
