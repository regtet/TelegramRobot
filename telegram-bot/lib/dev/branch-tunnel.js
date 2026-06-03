const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const chalk = require('chalk');
const paths = require('../paths');

const CLOUDFLARED_CACHE_EXE = path.join(paths.VAR_DIR, 'cloudflared.exe');
let ensureCloudflaredInflight = null;

/** 仅当显式配置 CLOUDFLARED_PROXY 时才给 cloudflared 设代理（勿复用 Telegram 的 PROXY_HOST，易导致 1033） */
function buildCloudflaredEnv() {
    const env = { ...process.env };
    const explicit = (process.env.CLOUDFLARED_PROXY || '').trim();
    if (!explicit) {
        return env;
    }
    env.HTTP_PROXY = explicit;
    env.HTTPS_PROXY = explicit;
    env.http_proxy = explicit;
    env.https_proxy = explicit;
    env.ALL_PROXY = explicit;
    return env;
}

function isCloudflaredNetworkError(err) {
    const msg = (err && err.message) || String(err);
    return /api\.trycloudflare\.com|trycloudflare\.com\/tunnel|context deadline exceeded|Client\.Timeout|connection refused|no such host/i.test(
        msg,
    );
}

function wrapCloudflaredError(err) {
    const msg = (err && err.message) || String(err);
    if (!isCloudflaredNetworkError(err)) {
        return err instanceof Error ? err : new Error(msg);
    }
    return new Error(
        `${msg}\n\n` +
            'cloudflared 无法连接 Cloudflare（api.trycloudflare.com）。\n' +
            '请开启 Clash「TUN 模式」或「系统代理」后重试；仅给 Telegram 配 SOCKS 代理通常不够。\n' +
            '请开启 Clash TUN 后重试 cloudflared（不要用 localtunnel，需填公网 IP 才能打开页面）。',
    );
}

async function fetchLocaltunnelAccessIp() {
    const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl';
    return new Promise((resolve, reject) => {
        const proc = spawn(
            curlBin,
            ['-s', '--max-time', '20', 'https://loca.lt/mytunnelpassword'],
            { shell: false, env: buildCloudflaredEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let out = '';
        proc.stdout.on('data', (d) => {
            out += d;
        });
        proc.on('error', reject);
        proc.on('close', (code) => {
            const ip = out.trim();
            if (code === 0 && ip && /^[\d.a-f:]+$/i.test(ip)) {
                resolve(ip);
                return;
            }
            reject(new Error('无法从 loca.lt/mytunnelpassword 获取访问 IP'));
        });
    });
}

async function startLocaltunnel(port) {
    const prevHttpProxy = process.env.HTTP_PROXY;
    const prevHttpsProxy = process.env.HTTPS_PROXY;
    try {
        const env = buildCloudflaredEnv();
        if (env.HTTP_PROXY) {
            process.env.HTTP_PROXY = env.HTTP_PROXY;
            process.env.HTTPS_PROXY = env.HTTPS_PROXY || env.HTTP_PROXY;
        }
        const localtunnel = require('localtunnel');
        const tunnel = await localtunnel({ port });
        let accessIp = null;
        try {
            accessIp = await fetchLocaltunnelAccessIp();
        } catch (e) {
            console.log(
                chalk.yellow(
                    `[穿透] 未获取到 loca.lt 访问 IP: ${(e && e.message) || e}`,
                ),
            );
        }
        return {
            publicUrl: tunnel.url,
            accessIp,
            close: () => tunnel.close(),
        };
    } finally {
        if (prevHttpProxy !== undefined) {
            process.env.HTTP_PROXY = prevHttpProxy;
        } else {
            delete process.env.HTTP_PROXY;
        }
        if (prevHttpsProxy !== undefined) {
            process.env.HTTPS_PROXY = prevHttpsProxy;
        } else {
            delete process.env.HTTPS_PROXY;
        }
    }
}

/** cloudflared 日志里会出现 api.trycloudflare.com，不是可访问的 quick tunnel */
const QUICK_TUNNEL_BLOCKLIST = new Set(['api', 'www', 'dash', 'developers', 'one']);
const DEV_READY_RE = /running here:\s*(https?:\/\/[^\s]+)/i;

function extractQuickTunnelUrl(logText) {
    if (!logText) return null;

    for (const line of String(logText).split(/\r?\n/)) {
        if (!/trycloudflare\.com/i.test(line)) continue;
        if (!/visit it at|quick tunnel has been created/i.test(line)) continue;
        const m = line.match(/https:\/\/[^\s|]+\.trycloudflare\.com/i);
        if (!m) continue;
        const url = m[0].replace(/[|\s]+$/g, '');
        const host = (url.match(/https:\/\/([^./]+)\./i) || [])[1];
        if (host && !QUICK_TUNNEL_BLOCKLIST.has(host.toLowerCase())) {
            return url;
        }
    }

    const re = /https:\/\/([a-zA-Z0-9-]+)\.trycloudflare\.com/gi;
    let last = null;
    let m;
    while ((m = re.exec(logText)) !== null) {
        const host = (m[1] || '').toLowerCase();
        if (!QUICK_TUNNEL_BLOCKLIST.has(host)) {
            last = m[0];
        }
    }
    return last;
}

/** cloudflared 已与边缘建立连接（仅有 Visit it at 链接时访问常会短暂 1033） */
const CF_EDGE_READY_RE =
    /Registered tunnel connection|Connection \d+ registered|Initial protocol (?:quic|http2)/i;

function waitForCloudflaredTunnelUrl(proc, timeoutMs) {
    const edgeWaitMs = parseInt(
        process.env.CLOUDFLARED_EDGE_WAIT_MS || '120000',
        10,
    );

    return new Promise((resolve, reject) => {
        let settled = false;
        let tail = '';
        let pendingUrl = null;
        let urlSeenAt = 0;
        let edgeTimer = null;

        const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (edgeTimer) clearTimeout(edgeTimer);
            fn(arg);
        };

        const tryResolveWhenReady = () => {
            if (!pendingUrl) return;
            if (CF_EDGE_READY_RE.test(tail)) {
                console.log(chalk.gray('[穿透] cloudflared 边缘连接已就绪'));
                finish(resolve, pendingUrl);
                return;
            }
            if (urlSeenAt && Date.now() - urlSeenAt >= edgeWaitMs) {
                console.log(
                    chalk.yellow(
                        `[穿透] ${Math.round(edgeWaitMs / 1000)}s 内未检测到边缘就绪日志，仍发送链接（若 1033 请稍等再刷新）`,
                    ),
                );
                finish(resolve, pendingUrl);
            }
        };

        const onChunk = (buf) => {
            tail = (tail + String(buf || '')).slice(-12000);
            const url = extractQuickTunnelUrl(tail);
            if (url && !pendingUrl) {
                pendingUrl = url;
                urlSeenAt = Date.now();
                console.log(chalk.gray(`[穿透] 已拿到链接，等待边缘连接… ${url}`));
                if (!edgeTimer) {
                    edgeTimer = setInterval(tryResolveWhenReady, 500);
                }
            }
            tryResolveWhenReady();
        };

        const timer = setTimeout(() => {
            const hint = tail.trim() ? `\n${tail.trim().slice(-500)}` : '';
            finish(
                reject,
                new Error(`cloudflared 未输出可访问链接（${Math.round(timeoutMs / 1000)}s）${hint}`),
            );
        }, timeoutMs);

        if (proc.stdout) proc.stdout.on('data', onChunk);
        if (proc.stderr) proc.stderr.on('data', onChunk);
        proc.on('error', (err) => finish(reject, err));
        proc.on('exit', (code) => {
            if (!settled && code != null && code !== 0) {
                const hint = tail.trim() ? `: ${tail.trim().slice(-300)}` : '';
                finish(reject, new Error(`cloudflared 进程退出 code=${code}${hint}`));
            }
        });
    });
}

function killProcessTree(proc) {
    if (!proc || proc.killed || !proc.pid) return;
    if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
            shell: true,
            stdio: 'ignore',
        });
    } else {
        try {
            proc.kill('SIGTERM');
        } catch (_) {
            // ignore
        }
    }
}

/**
 * Windows + Node 22：不能直接 spawn *.cmd（会 EINVAL），需 shell:true 或调用 .exe
 */
function spawnProcess(command, args, options = {}) {
    const cmd = String(command || '').trim();
    const isWin = process.platform === 'win32';
    const isExe = /\.exe$/i.test(cmd);
    const useShell = options.shell != null ? options.shell : isWin && !isExe;

    return spawn(cmd, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
        shell: useShell,
    });
}

function findCloudflaredInNpxCache() {
    const binName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const roots = [];
    if (process.env.LOCALAPPDATA) {
        roots.push(path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx'));
    }
    roots.push(path.join(os.homedir(), '.npm', '_npx'));

    let best = null;
    let bestMtime = 0;
    for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        let dirs;
        try {
            dirs = fs.readdirSync(root);
        } catch {
            continue;
        }
        for (const dir of dirs) {
            const candidate = path.join(
                root,
                dir,
                'node_modules',
                'cloudflared',
                'bin',
                binName,
            );
            if (!fs.existsSync(candidate)) continue;
            const mt = fs.statSync(candidate).mtimeMs;
            if (mt > bestMtime) {
                bestMtime = mt;
                best = candidate;
            }
        }
    }
    return best;
}

function copyCloudflaredToStableCache(src) {
    paths.ensureDirs();
    try {
        fs.copyFileSync(src, CLOUDFLARED_CACHE_EXE);
        return CLOUDFLARED_CACHE_EXE;
    } catch (e) {
        console.log(chalk.yellow(`[穿透] 缓存 cloudflared 失败，使用 npx 路径: ${e.message}`));
        return src;
    }
}

function runShellCommand(command, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, [], { shell: true, stdio: 'ignore' });
        const timer = setTimeout(() => {
            killProcessTree(proc);
            reject(new Error('命令执行超时'));
        }, timeoutMs);
        proc.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        proc.on('exit', (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`命令失败 code=${code}`));
            }
        });
    });
}

async function ensureCloudflaredExecutable() {
    if (fs.existsSync(CLOUDFLARED_CACHE_EXE)) {
        return CLOUDFLARED_CACHE_EXE;
    }

    let cached = findCloudflaredInNpxCache();
    if (cached) {
        return copyCloudflaredToStableCache(cached);
    }

    if (!ensureCloudflaredInflight) {
        ensureCloudflaredInflight = (async () => {
            console.log(chalk.gray('[穿透] 首次使用，正在通过 npx 下载 cloudflared…'));
            await runShellCommand('npx --yes cloudflared@latest --version');
            const found = findCloudflaredInNpxCache();
            if (!found) {
                throw new Error(
                    'npx 下载完成但未找到 cloudflared.exe，请在 .env 配置 CLOUDFLARED_PATH',
                );
            }
            return copyCloudflaredToStableCache(found);
        })().finally(() => {
            ensureCloudflaredInflight = null;
        });
    }

    return ensureCloudflaredInflight;
}

async function resolveCloudflaredExecutable(explicitPath) {
    const trimmed = explicitPath && String(explicitPath).trim();
    if (trimmed && trimmed.toLowerCase() !== 'cloudflared') {
        let cmd = path.isAbsolute(trimmed)
            ? trimmed
            : path.resolve(paths.ROOT, trimmed);
        if (!fs.existsSync(cmd) && process.platform === 'win32') {
            if (!/\.exe$/i.test(cmd) && fs.existsSync(`${cmd}.exe`)) {
                cmd = `${cmd}.exe`;
            } else if (/\.exe$/i.test(cmd) && fs.existsSync(`${cmd}.exe`)) {
                // 浏览器下载常变成 cloudflared.exe.exe
                cmd = `${cmd}.exe`;
            }
        }
        if (fs.existsSync(cmd)) {
            return { cmd, mode: 'local' };
        }
        console.log(
            chalk.yellow(
                `[穿透] CLOUDFLARED_PATH 不存在 (${cmd})，改用 npx 缓存的 cloudflared`,
            ),
        );
    }

    const cmd = await ensureCloudflaredExecutable();
    return { cmd, mode: 'cached' };
}

function waitForHttpReady(port, timeoutMs = 120000) {
    const host = '127.0.0.1';
    const started = Date.now();

    return new Promise((resolve, reject) => {
        const tryOnce = () => {
            if (Date.now() - started > timeoutMs) {
                reject(new Error(`开发服务未在 ${timeoutMs / 1000}s 内就绪（端口 ${port}）`));
                return;
            }

            const req = http.get(`http://${host}:${port}/`, (res) => {
                res.resume();
                resolve(`http://${host}:${port}`);
            });
            req.on('error', () => {
                setTimeout(tryOnce, 1500);
            });
            req.setTimeout(3000, () => {
                req.destroy();
                setTimeout(tryOnce, 1500);
            });
        };
        tryOnce();
    });
}

function waitForRegexInStream(proc, regex, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let tail = '';

        const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(arg);
        };

        const onChunk = (buf) => {
            const text = String(buf || '');
            tail = (tail + text).slice(-4000);
            const m = text.match(regex);
            if (m) {
                finish(resolve, m[0] || m[1]);
            }
        };

        const timer = setTimeout(() => {
            const hint = tail.trim() ? `\n${tail.trim().slice(-500)}` : '';
            finish(reject, new Error(`${label} 超时（${Math.round(timeoutMs / 1000)}s）${hint}`));
        }, timeoutMs);

        if (proc.stdout) proc.stdout.on('data', onChunk);
        if (proc.stderr) proc.stderr.on('data', onChunk);
        proc.on('error', (err) => finish(reject, err));
        proc.on('exit', (code) => {
            if (!settled && code != null && code !== 0) {
                const hint = tail.trim() ? `: ${tail.trim().slice(-300)}` : '';
                finish(reject, new Error(`${label} 进程退出 code=${code}${hint}`));
            }
        });
    });
}

class BranchTunnelManager {
    /**
     * @param {{ cloudflaredPath?: string, devPort?: number, durationMs?: number }} options
     */
    constructor(options = {}) {
        this.cloudflaredPath = options.cloudflaredPath || '';
        this.devPort = options.devPort || 8088;
        this.durationMs = options.durationMs || 10 * 60 * 1000;
        /** @type {Map<string, object>} */
        this.byProject = new Map();
    }

    isProjectBusy(projectName) {
        return this.byProject.has(projectName);
    }

    async stop(projectName, reason) {
        const active = this.byProject.get(projectName);
        if (!active) return;
        if (active.timer) clearTimeout(active.timer);
        killProcessTree(active.devProc);
        killProcessTree(active.cfProc);
        if (active.closeTunnel) {
            try {
                active.closeTunnel();
            } catch (_) {
                // ignore
            }
        }
        this.byProject.delete(projectName);
        if (reason) {
            console.log(
                chalk.gray(`[穿透] 已停止 ${projectName}/${active.branchName}: ${reason}`),
            );
        }
    }

    async spawnCloudflared(localUrl) {
        const url = localUrl.replace(/\/$/, '');
        const { cmd, mode } = await resolveCloudflaredExecutable(this.cloudflaredPath);
        const args = ['tunnel', '--url', url];
        const cfProxy = (process.env.CLOUDFLARED_PROXY || '').trim();
        const cfProtocol = (process.env.CLOUDFLARED_PROTOCOL || '').trim().toLowerCase();
        if (cfProtocol === 'http2' || (cfProxy && cfProtocol !== 'quic')) {
            args.splice(1, 0, '--protocol', 'http2');
        }
        const cfEnv = buildCloudflaredEnv();
        if (cfEnv.HTTP_PROXY) {
            console.log(chalk.gray(`[穿透] cloudflared 代理: ${cfEnv.HTTP_PROXY}`));
        } else {
            console.log(chalk.gray('[穿透] cloudflared 直连（方案 A：依赖 Clash TUN/系统代理）'));
        }
        console.log(chalk.gray(`[穿透] 启动隧道(${mode}): ${cmd} ${args.join(' ')}`));
        return spawn(cmd, args, {
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: cfEnv,
        });
    }

    /**
     * 切换分支 → 启动 yarn dev → cloudflared 公网链接，默认 10 分钟后自动关闭
     */
    async start({
        project,
        branchName,
        chatId,
        client,
        enqueueProjectGitWork,
        ensureProjectOnBranchForAnalyze,
    }) {
        const projectName = project.name;
        await this.stop(projectName, '被新穿透请求替换');

        await enqueueProjectGitWork(projectName, async () => {
            await ensureProjectOnBranchForAnalyze(project, branchName);
        });

        const devProc = spawnProcess('yarn', ['dev'], {
            cwd: project.path,
            env: {
                ...process.env,
                PORT: String(this.devPort),
                TUNNEL_DEV: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let localUrl = `http://127.0.0.1:${this.devPort}`;
        try {
            const matched = await Promise.race([
                waitForRegexInStream(devProc, DEV_READY_RE, 180000, 'webpack-dev-server'),
                waitForHttpReady(this.devPort, 180000),
            ]);
            if (typeof matched === 'string' && matched.startsWith('http')) {
                localUrl = matched.replace(/\/$/, '');
            }
        } catch (err) {
            killProcessTree(devProc);
            throw err;
        }

        let cfProc = null;
        let closeTunnel = null;
        let publicUrl;
        let tunnelMode = 'cloudflared';
        let accessIp = null;

        try {
            cfProc = await this.spawnCloudflared(localUrl);
            publicUrl = await waitForCloudflaredTunnelUrl(cfProc, 180000);
            console.log(chalk.green(`[穿透] 公网链接(cloudflared): ${publicUrl}`));
        } catch (err) {
            killProcessTree(cfProc);
            cfProc = null;

            const allowLt = process.env.TUNNEL_FALLBACK_LOCALTUNNEL === 'true';
            if (allowLt && isCloudflaredNetworkError(err)) {
                try {
                    console.log(
                        chalk.yellow('[穿透] cloudflared 连不上 Cloudflare，尝试 localtunnel…'),
                    );
                    const lt = await startLocaltunnel(this.devPort);
                    publicUrl = lt.publicUrl;
                    closeTunnel = lt.close;
                    tunnelMode = 'localtunnel';
                    accessIp = lt.accessIp;
                    console.log(chalk.green(`[穿透] 公网链接(localtunnel): ${publicUrl}`));
                } catch (ltErr) {
                    killProcessTree(devProc);
                    console.log(
                        chalk.yellow(
                            `[穿透] localtunnel 也失败: ${(ltErr && ltErr.message) || ltErr}`,
                        ),
                    );
                    throw wrapCloudflaredError(err);
                }
            } else {
                killProcessTree(devProc);
                throw wrapCloudflaredError(err);
            }
        }

        const expiresAt = Date.now() + this.durationMs;
        const timer = setTimeout(() => {
            this.stop(projectName, '10 分钟到期').catch(() => {});
            if (client && chatId) {
                client
                    .sendMessage(chatId, {
                        message: `⏱️ 穿透 ${branchName} 已结束（10 分钟）`,
                        linkPreview: false,
                    })
                    .catch(() => {});
            }
        }, this.durationMs);

        this.byProject.set(projectName, {
            branchName,
            devProc,
            cfProc,
            closeTunnel,
            tunnelMode,
            timer,
            publicUrl,
            localUrl,
            chatId,
            expiresAt,
        });

        return {
            publicUrl,
            branchName,
            projectName,
            localUrl,
            expiresAt,
            tunnelMode,
            accessIp,
        };
    }
}

module.exports = { BranchTunnelManager, killProcessTree };
