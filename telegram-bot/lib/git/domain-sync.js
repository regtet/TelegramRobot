const chalk = require('chalk');
const { applyDomainUpdate } = require('../core/config-writer');
const { RETRY_ATTEMPTS, RETRY_DELAY_MS, delay } = require('./package-id-sync');

function isNothingToCommitError(error) {
    return /nothing to commit/i.test(String(error || ''));
}

/**
 * 修改域名配置并提交推送
 * @param {import('../build/builder')} builder
 * @param {{ branchName: string, domain: string, backup?: boolean }} options
 */
async function syncDomainConfigWithGit(builder, options) {
    const branchName = String(options.branchName || '').trim();
    const domain = String(options.domain || '').trim();
    const backup = Boolean(options.backup);
    const modeText = backup ? '备用域名' : '主域名';
    const updateResult = applyDomainUpdate(builder.projectPath, { domain, backup });
    if (!updateResult.success) {
        return { ok: false, skipped: false, error: updateResult.error || `写入${modeText}失败` };
    }
    if (!updateResult.changed) {
        return { ok: true, skipped: true, domain: updateResult.normalizedDomain || domain };
    }

    const normalizedDomain = updateResult.normalizedDomain || domain;
    const commitMsg = backup
        ? `update：添加备用域名 ${normalizedDomain}`
        : `update：添加域名 ${normalizedDomain}`;
    let lastError = '';
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
        const onBranch = await builder.ensureOnBranch(branchName);
        if (!onBranch.success) {
            lastError = onBranch.error || '无法切换到目标分支';
        } else {
            const addResult = await builder.runGit(['add', 'src/config/config.js', 'src/config/server.js']);
            if (!addResult.success) {
                lastError = addResult.error || 'git add 失败';
            } else {
                const commitResult = await builder.runGit(['commit', '-m', commitMsg]);
                if (!commitResult.success && !isNothingToCommitError(commitResult.error)) {
                    lastError = commitResult.error || 'git commit 失败';
                } else {
                    const pushResult = await builder.runGit(['push', 'origin', branchName]);
                    if (pushResult.success) {
                        return { ok: true, skipped: false, domain: normalizedDomain };
                    }
                    lastError = pushResult.error || 'git push 失败';
                }
            }
        }
        if (attempt < RETRY_ATTEMPTS) {
            console.log(
                chalk.yellow(
                    `⚠ ${modeText}同步第 ${attempt} 次失败，${RETRY_DELAY_MS / 1000}s 后重试: ${lastError}`,
                ),
            );
            await delay(RETRY_DELAY_MS);
        }
    }
    return { ok: false, skipped: false, error: lastError, domain: normalizedDomain };
}

module.exports = {
    syncDomainConfigWithGit,
};
