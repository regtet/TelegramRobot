/**
 * 打包服务（47.128.239.172:8000）HTTP 客户端：/list 查询、/pack 触发、APK 下载。
 * 通过工厂注入 proxy / log，行为与原 index.js 内实现保持一致。
 */
const fs = require('fs');
const axios = require('axios');
const chalk = require('chalk');
const { errMsg } = require('../core/err');

const PACK_SERVER_BASE = 'http://47.128.239.172:8000';

/**
 * @param {{ proxy?: object, log: { append: (cat: string, msg: string) => void } }} deps
 */
function createPackServerClient({ proxy, log }) {
    // 并发批量打包时合并对 /list 的并发请求（共用同一 in-flight Promise）
    let listInflight = null;

    async function fetchFileList() {
        if (listInflight) {
            return listInflight;
        }
        listInflight = (async () => {
            try {
                const res = await axios.get(`${PACK_SERVER_BASE}/list`, {
                    timeout: 10000,
                    proxy,
                });
                const files = res.data && Array.isArray(res.data.files) ? res.data.files : [];
                log.append('LIST', `OK files=${files.length}`);
                return files;
            } catch (error) {
                log.append('LIST', `FAIL ${errMsg(error)}`);
                throw error;
            } finally {
                listInflight = null;
            }
        })();
        return listInflight;
    }

    async function callPackApi(appNameSlug, webUrl, imageUrl) {
        const slugForPack = (appNameSlug || '').toLowerCase();

        const payload = [
            {
                app_name: slugForPack || appNameSlug,
                web_url: webUrl,
                image_url: imageUrl,
            },
        ];

        console.log(chalk.cyan(`📦 调用打包接口: app_name=${slugForPack || appNameSlug}, web_url=${webUrl}, image_url=${imageUrl}`));

        const maxAttempts = 3;
        const retryDelayMs = 5000;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await axios.post(`${PACK_SERVER_BASE}/pack`, payload, {
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent':
                            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
                        'Accept': '*/*',
                        'Accept-Language': 'zh-CN,zh;q=0.9',
                        'Connection': 'keep-alive',
                    },
                    timeout: 60000, // 不动原有超时时间
                    proxy,
                });

                console.log(chalk.green('✅ 打包接口触发成功'));
                return;
            } catch (error) {
                log.append('PACK', `调用 /pack 失败 ${attempt}/${maxAttempts}: ${error.message}`);
                console.log(chalk.yellow(`⚠ 调用打包接口失败（第 ${attempt}/${maxAttempts} 次）：${error.message}`));
                if (attempt === maxAttempts) {
                    // socket hang up / 连接被重置：视为触发成功但对方主动断开，继续后续轮询
                    const msg = (error && error.message) || '';
                    if (error && (error.code === 'ECONNRESET' || /socket hang up/i.test(msg))) {
                        console.log(chalk.yellow('⚠ 打包接口连接被对方关闭（socket hang up），将继续轮询 /list 检查打包结果'));
                        return;
                    }
                    throw error;
                }
                await new Promise((r) => setTimeout(r, retryDelayMs));
            }
        }
    }

    // 带重试的文件下载（用于从打包服务器下载 APK）
    async function downloadFileWithRetry(url, localPath, maxAttempts = 12, timeoutMs = 15000) {
        const retryDelayMs = 5000;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            log.append('DOWNLOAD', `APK 下载 ${attempt}/${maxAttempts} ${url}`);

            try {
                const response = await axios.get(url, {
                    responseType: 'stream',
                    timeout: timeoutMs,
                    proxy,
                });

                await new Promise((resolve, reject) => {
                    try {
                        if (fs.existsSync(localPath)) {
                            fs.unlinkSync(localPath);
                        }
                    } catch {
                        // 忽略，交给后续写入阶段处理
                    }
                    const writer = fs.createWriteStream(localPath);
                    response.data.pipe(writer);
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });

                log.append('DOWNLOAD', `完成 ${localPath}`);
                console.log(chalk.green(`📦 APK 下载完成`));
                return;
            } catch (error) {
                const msg = (error && error.message) || '';
                const code = error && error.code;

                log.append('DOWNLOAD', `失败 ${attempt}/${maxAttempts} ${msg}`);

                const isRetryable =
                    code === 'ECONNRESET' ||
                    code === 'ETIMEDOUT' ||
                    code === 'EPERM' ||
                    code === 'EACCES' ||
                    code === 'EBUSY' ||
                    /socket hang up/i.test(msg) ||
                    /timeout/i.test(msg) ||
                    /operation not permitted/i.test(msg);

                if (!isRetryable || attempt === maxAttempts) {
                    throw error;
                }

                await new Promise((r) => setTimeout(r, retryDelayMs));
            }
        }
    }

    return { fetchFileList, callPackApi, downloadFileWithRetry };
}

module.exports = { createPackServerClient, PACK_SERVER_BASE };
