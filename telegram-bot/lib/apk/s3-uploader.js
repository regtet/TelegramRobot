/**
 * S3 上传（带超时与重试）。通过工厂注入 s3Client / bucket / region / log，
 * 行为与原 index.js 内 uploadFileToS3 保持一致。
 */
const fs = require('fs');
const chalk = require('chalk');
const { PutObjectCommand } = require('@aws-sdk/client-s3');

/**
 * @param {{ s3Client: object, bucket: string, region: string, log: { append: (cat: string, msg: string) => void } }} deps
 */
function createS3Uploader({ s3Client, bucket, region, log }) {
    async function uploadFileToS3(
        localFilePath,
        key,
        contentType = 'application/octet-stream',
        uploadTimeoutMs = 60000,
    ) {
        if (!bucket) {
            log.append('S3', '未配置 S3_BUCKET');
            console.log(chalk.red('❌ 未配置 S3_BUCKET，无法上传到 S3'));
            throw new Error('S3_BUCKET 未配置');
        }

        if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
            log.append('S3', '未配置 AWS 凭证');
            console.log(chalk.red('❌ 未配置 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY，无法上传到 S3'));
            throw new Error('AWS 凭证未配置');
        }

        const maxAttempts = 10;
        const delayMs = 3000;
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            log.append('S3', `尝试 ${attempt}/${maxAttempts} bucket=${bucket} key=${key}`);

            try {
                const fileStream = fs.createReadStream(localFilePath);

                const command = new PutObjectCommand({
                    Bucket: bucket,
                    Key: key,
                    Body: fileStream,
                    ContentType: contentType,
                });

                // 为每次上传设置超时，超时则主动中止本次请求并记为一次失败
                const abortController = new AbortController();
                const timeoutId = setTimeout(() => {
                    abortController.abort();
                }, uploadTimeoutMs);

                try {
                    await s3Client.send(command, { abortSignal: abortController.signal });
                } finally {
                    clearTimeout(timeoutId);
                }

                log.append('S3', `成功 key=${key}`);
                console.log(chalk.green(`✅ 上传到 S3 成功: ${key}`));

                const publicUrl = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
                return { key, url: publicUrl };
            } catch (error) {
                lastError = error;
                const msg = (error && error.message) || '';
                const code = (error && error.code) || (error && error.cause && error.cause.code) || '';

                log.append('S3', `失败 ${attempt}/${maxAttempts} code=${code} msg=${msg}`);

                const isAbortError =
                    (error && error.name === 'AbortError') ||
                    /Request aborted/i.test(msg);

                const isAwsRequestTimeout =
                    (error && (error.Code === 'RequestTimeout' || error.name === 'RequestTimeout')) ||
                    /Your socket connection to the server was not read from or written to within the timeout period\. Idle connections will be closed\./i.test(msg);

                const isInvalidHeaderValue =
                    (error && error.code === 'ERR_HTTP_INVALID_HEADER_VALUE') ||
                    /Invalid value "undefined" for header "x-amz-decoded-content-length"/i.test(msg);

                const retryable =
                    isAbortError ||
                    isAwsRequestTimeout ||
                    isInvalidHeaderValue ||
                    /Client network socket disconnected before secure TLS connection was established/i.test(msg) ||
                    code === 'ECONNRESET' ||
                    code === 'ETIMEDOUT' ||
                    code === 'EPIPE' ||
                    code === 'EAI_AGAIN' ||
                    /ECONNRESET/i.test(msg) ||
                    /ETIMEDOUT/i.test(msg) ||
                    /EAI_AGAIN/i.test(msg) ||
                    /socket hang up/i.test(msg) ||
                    /network error/i.test(msg) ||
                    /non-retryable streaming request/i.test(msg);

                if (!retryable || attempt === maxAttempts) {
                    log.append('S3', `终止重试 retryable=${retryable} last=${msg}`);
                    console.log(chalk.red(`❌ 上传到 S3 失败（已写日志）: ${key}`));
                    break;
                }

                log.append('S3', `${delayMs / 1000}s 后重试`);
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }

        throw lastError || new Error('上传到 S3 失败（未知错误）');
    }

    return { uploadFileToS3 };
}

module.exports = { createS3Uploader };
