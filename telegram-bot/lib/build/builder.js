const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { packDistWithRar } = require('./rar-pack');

// 是否打印每条 shell 命令的详细日志（默认关闭，避免刷屏）
// 需要排查时可临时设置环境变量 ENABLE_COMMAND_LOG=1
const ENABLE_COMMAND_LOG = process.env.ENABLE_COMMAND_LOG === '1';

class Builder {
  constructor(projectPath, config) {
    this.projectPath = path.isAbsolute(projectPath)
      ? path.resolve(projectPath)
      : path.resolve(__dirname, '..', '..', projectPath);
    this.config = config;
  }

  /**
   * 终止当前正在执行的 shell 命令（含 npm build 子进程树）
   */
  killActiveCommand() {
    const child = this._activeChild;
    if (!child || !child.pid) return false;
    this._killedCommand = child;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } else {
        child.kill('SIGTERM');
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * spawn 子进程（shell 或 argv），供 runCommand / runGit 共用
   */
  _spawnTracked(spawnFile, spawnArgs, cwd, options = {}) {
    const { silent = false, shell = false } = options;

    return new Promise((resolve) => {
      const child = spawn(spawnFile, spawnArgs, {
        cwd,
        shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this._activeChild = child;
      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (this._activeChild === child) {
          this._activeChild = null;
        }
        if (this._killedCommand === child) {
          this._killedCommand = null;
        }
        resolve(result);
      };

      const appendOutput = (chunk, target) => {
        const text = chunk.toString();
        if (target === 'stdout') stdout += text;
        else stderr += text;
        const combined = stdout.length + stderr.length;
        if (combined > 10 * 1024 * 1024) {
          child.kill();
          finish({ success: false, error: '命令输出超过 10MB 上限' });
        }
      };

      child.stdout?.on('data', (d) => appendOutput(d, 'stdout'));
      child.stderr?.on('data', (d) => appendOutput(d, 'stderr'));

      child.on('error', (error) => {
        if (!silent) {
          console.error(chalk.red('命令执行失败:'), error.message);
        }
        finish({ success: false, error: error.message });
      });

      child.on('close', (code, signal) => {
        if (ENABLE_COMMAND_LOG && stderr && !stderr.includes('warning')) {
          console.log(chalk.yellow('警告:'), stderr);
        }
        if (code === 0) {
          finish({ success: true, output: stdout });
          return;
        }
        if (this._killedCommand === child) {
          finish({ success: false, error: 'BUILD_ABORTED', aborted: true });
          return;
        }
        const hint = signal ? `signal ${signal}` : `exit ${code}`;
        const errMsg = stderr.trim() || stdout.trim() || hint;
        if (!silent) {
          console.error(chalk.red('命令执行失败:'), errMsg);
        }
        finish({ success: false, error: errMsg });
      });
    });
  }

  /**
   * 直接调用 git（参数数组，避免 Windows cmd 吃掉引号 / % 占位符）
   */
  async runGit(args, cwd = this.projectPath, options = {}) {
    if (ENABLE_COMMAND_LOG) {
      console.log(chalk.blue(`执行命令: git ${args.join(' ')}`));
      console.log(chalk.gray(`工作目录: ${cwd}`));
    }
    return this._spawnTracked('git', args, cwd, options);
  }

  /**
   * 执行 shell 命令并返回结果（spawn + shell:true，与旧版 exec 行为一致，且可 kill）
   */
  async runCommand(command, cwd = this.projectPath, options = {}) {
    if (ENABLE_COMMAND_LOG) {
      console.log(chalk.blue(`执行命令: ${command}`));
      console.log(chalk.gray(`工作目录: ${cwd}`));
    }

    return this._spawnTracked(command, [], cwd, { ...options, shell: true });
  }

  /**
   * 检查项目目录是否存在
   */
  checkProjectExists() {
    if (!fs.existsSync(this.projectPath)) {
      throw new Error(`项目目录不存在: ${this.projectPath}`);
    }
    console.log(chalk.green('✓ 项目目录检查通过'));
    return true;
  }

  /**
   * 获取所有分支列表
   */
  async getBranches() {
    // 在获取分支前先尝试刷新远程分支，确保与远程同步
    if (this.config.autoFetchPull !== false) {
      const fetchResult = await this.runCommand('git fetch --all --prune');
      if (!fetchResult.success) {
        console.log(chalk.yellow('⚠ 刷新远程分支失败，使用现有分支列表'));
      } else {
        console.log(chalk.green('✓ 已刷新远程分支列表'));
      }
    }

    const result = await this.runCommand('git branch -a');
    if (!result.success) {
      throw new Error('获取分支列表失败');
    }

    const branches = result.output
      .split('\n')
      .map(line => {
        return line
          .trim()
          .replace(/^\*\s*/, '')
          .replace(/^remotes\/[^/]+\//, '')
          .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ''); // 清理不可见字符
      })
      .filter(line => line && !line.includes('HEAD'));

    return [...new Set(branches)];
  }

  /**
   * 验证分支是否存在
   * @param {string} branchName - 分支名
   * @returns {Promise<boolean>} - 分支是否存在
   */
  async branchExists(branchName) {
    // 先尝试获取所有分支（使用缓存）
    if (!this._branchesCache) {
      try {
        this._branchesCache = await this.getBranches();
      } catch (error) {
        // 如果获取失败，尝试直接检查单个分支
        const result = await this.runCommand(`git show-ref --verify --quiet refs/heads/${branchName} || git show-ref --verify --quiet refs/remotes/origin/${branchName}`);
        return result.success;
      }
    }

    // 检查本地分支和远程分支
    return this._branchesCache.includes(branchName);
  }

  /**
   * 验证多个分支是否存在
   * @param {Array<string>} branchNames - 分支名数组
   * @returns {Promise<{valid: Array<string>, invalid: Array<string>}>} - 返回有效和无效的分支
   */
  async validateBranches(branchNames, options = {}) {
    const reuseCache = Boolean(options && options.reuseCache);
    if (!reuseCache) {
      this._branchesCache = null;
    }

    try {
      if (!this._branchesCache) {
        this._branchesCache = await this.getBranches();
      }
    } catch (error) {
      console.log(chalk.yellow('⚠ 无法获取分支列表，将在执行时验证'));
      // 如果获取失败，返回所有分支为待验证状态
      return { valid: branchNames, invalid: [] };
    }

    const valid = [];
    const invalid = [];

    for (const branchName of branchNames) {
      // 清理分支名中的不可见字符后再匹配
      const cleanBranchName = branchName.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '').trim();

      // 精确匹配或忽略大小写匹配（git 分支名通常大小写敏感，但有些系统可能不敏感）
      const found = this._branchesCache.find(b => {
        const cleanB = b.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '').trim();
        return cleanB === cleanBranchName || cleanB.toLowerCase() === cleanBranchName.toLowerCase();
      });

      if (found) {
        // 返回实际匹配到的分支名（清理后的）
        valid.push(found.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '').trim());
      } else {
        invalid.push(cleanBranchName);
      }
    }

    return { valid, invalid };
  }

  /**
   * 中止进行中的 merge/rebase/cherry-pick（失败时忽略）
   */
  async abortInProgressGitOperations() {
    const silent = { silent: true };
    await this.runGit(['merge', '--abort'], this.projectPath, silent);
    await this.runGit(['rebase', '--abort'], this.projectPath, silent);
    await this.runGit(['cherry-pick', '--abort'], this.projectPath, silent);
  }

  /**
   * 打包机专用：丢弃本地改动与未完成的合并，恢复可切换分支的干净状态
   */
  async forceCleanWorkspace() {
    await this.abortInProgressGitOperations();
    const resetResult = await this.runCommand('git reset --hard HEAD');
    const cleanResult = await this.runCommand('git clean -fd');
    return resetResult.success || cleanResult.success;
  }

  async isDetachedHead() {
    const r = await this.runGit(['symbolic-ref', '-q', 'HEAD'], this.projectPath, { silent: true });
    return !r.success;
  }

  /**
   * 确保当前在指定本地分支上（修复 detached HEAD / 短分支名歧义）
   */
  async ensureOnBranch(branchName) {
    if (!branchName) {
      return { success: false, error: '缺少分支名' };
    }

    const detached = await this.isDetachedHead();
    if (!detached) {
      const cur = await this.runGit(
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        this.projectPath,
        { silent: true },
      );
      if (cur.success && cur.output.trim() === branchName) {
        return { success: true };
      }
    }

    const remoteRef = `origin/${branchName}`;
    const remoteOk = await this.runGit(
      ['rev-parse', '--verify', remoteRef],
      this.projectPath,
      { silent: true },
    );
    if (remoteOk.success) {
      return this.runGit(['checkout', '-B', branchName, remoteRef]);
    }
    return this.runGit(['checkout', '-B', branchName]);
  }

  /**
   * 将当前分支硬同步到 origin（避免 git pull 产生合并冲突）
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async hardResetBranchToOrigin(branchName) {
    const remoteRef = `origin/${branchName}`;
    const verify = await this.runGit(['rev-parse', '--verify', remoteRef]);
    if (!verify.success) {
      return { success: false, error: `远程不存在 ${remoteRef}` };
    }
    await this.forceCleanWorkspace();
    // 用 checkout -B 而非 reset --hard origin/*，避免停留在 detached HEAD
    const checkout = await this.runGit(['checkout', '-B', branchName, remoteRef]);
    if (!checkout.success) {
      return { success: false, error: checkout.error || `checkout -B ${branchName} 失败` };
    }
    return { success: true };
  }

  /**
   * 切换分支并拉取最新代码
   */
  async checkoutAndPull(branchName) {
    console.log(chalk.cyan(`\n📥 切换到分支: ${branchName}`));

    let result;
    const retries = 3;

    // 如果启用自动拉取
    if (this.config.autoFetchPull) {
      // 1. Fetch 所有分支（带重试）
      for (let i = 0; i < retries; i++) {
        result = await this.runCommand('git fetch --all --prune');
        if (result.success) break;

        if (i < retries - 1) {
          console.log(chalk.yellow(`⚠ Fetch 失败，${3 - i} 秒后重试... (${i + 1}/${retries})`));
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }

      if (!result.success) {
        throw new Error(`Fetch 失败: ${result.error}\n\n💡 请检查网络连接或稍后重试`);
      }
      console.log(chalk.green('✓ Fetch 完成'));
    } else {
      console.log(chalk.yellow('⚠ 跳过 Fetch（autoFetchPull=false）'));
    }

    // 1.5. 清理工作区（含未完成的 merge/rebase），确保可以切换分支
    console.log(chalk.cyan('🧹 清理工作区...'));
    await this.forceCleanWorkspace();
    console.log(chalk.green('✓ 工作区已清理'));

    // 2. 切换分支（-B 强制落在分支上，避免短名如 01bb2 被当成 commit 进入 detached HEAD）
    const remoteRef = `origin/${branchName}`;
    const hasRemote = await this.runGit(
      ['rev-parse', '--verify', remoteRef],
      this.projectPath,
      { silent: true },
    );
    if (hasRemote.success) {
      result = await this.runGit(['checkout', '-B', branchName, remoteRef]);
    } else {
      result = await this.runGit(['checkout', '-B', branchName]);
    }
    if (!result.success) {
      console.log(chalk.yellow('⚠ 普通切换失败，尝试强制清理后重试...'));
      await this.forceCleanWorkspace();
      if (hasRemote.success) {
        result = await this.runGit(['checkout', '-B', branchName, remoteRef]);
      } else {
        result = await this.runGit(['checkout', '-f', '-B', branchName]);
      }

      if (!result.success) {
        throw new Error(`切换分支失败: ${result.error}`);
      }
    }
    console.log(chalk.green(`✓ 已切换到 ${branchName}`));

    // 3. 与远程同步（优先 hard reset，避免 pull 合并冲突）
    if (this.config.autoFetchPull) {
      let synced = false;
      let lastError = '';

      for (let i = 0; i < retries; i++) {
        if (i > 0) {
          console.log(
            chalk.yellow(`⚠ 同步远程失败，清理冲突后重试... (${i + 1}/${retries})`),
          );
          await this.forceCleanWorkspace();
          if (hasRemote.success) {
            await this.runGit(['checkout', '-B', branchName, remoteRef]);
          } else {
            await this.runGit(['checkout', '-f', '-B', branchName]);
          }
        }

        const resetResult = await this.hardResetBranchToOrigin(branchName);
        if (resetResult.success) {
          synced = true;
          break;
        }
        lastError = resetResult.error || 'hard reset 失败';

        // 无 origin/分支 时回退 git pull（仍会在每次重试前 forceClean）
        const pullResult = await this.runCommand('git pull --no-edit');
        if (pullResult.success) {
          synced = true;
          break;
        }
        lastError = pullResult.error || lastError;

        if (i < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }

      if (!synced) {
        await this.forceCleanWorkspace();
        throw new Error(
          `拉取代码失败: ${lastError}\n\n💡 本地合并冲突已清理；若仍失败请检查远程分支或网络`,
        );
      }
      console.log(chalk.green('✓ 代码已更新'));
    } else {
      console.log(chalk.yellow('⚠ 跳过 Pull（autoFetchPull=false）'));
      console.log(chalk.cyan('使用本地已有代码'));
    }

    // 4. 获取最新 commit 信息
    result = await this.runGit([
      'log',
      '-1',
      '--pretty=format:%h - %s (%an, %ar)',
    ]);
    const commitInfo = result.success ? result.output : '无法获取';

    return { branchName, commitInfo };
  }

  /**
   * 检查并安装依赖
   */
  async installDependencies() {
    console.log(chalk.cyan('\n📦 检查依赖...'));

    const packageJsonPath = path.join(this.projectPath, 'package.json');
    const nodeModulesPath = path.join(this.projectPath, 'node_modules');

    // 检查 node_modules 是否存在
    if (!fs.existsSync(nodeModulesPath)) {
      console.log(chalk.yellow('node_modules 不存在，开始安装...'));
      const result = await this.runCommand('npm install');
      if (!result.success) {
        throw new Error(`依赖安装失败: ${result.error}`);
      }
      console.log(chalk.green('✓ 依赖安装完成'));
      return;
    }

    // 如果配置了自动安装，则每次都安装
    if (this.config.autoInstall) {
      console.log(chalk.yellow('执行 npm install...'));
      const result = await this.runCommand('npm install');
      if (!result.success) {
        console.log(chalk.yellow('⚠ npm install 有警告，继续构建...'));
      } else {
        console.log(chalk.green('✓ 依赖更新完成'));
      }
    } else {
      console.log(chalk.green('✓ 跳过依赖安装'));
    }
  }

  /** 构建前删除整个 dist，避免跨分支或 introduce 等目录残留 */
  cleanDistFolder() {
    const distPath = path.join(this.projectPath, this.config.distPath || 'dist');
    if (!fs.existsSync(distPath)) {
      return;
    }
    console.log(chalk.cyan('🧹 删除旧 dist 目录...'));
    fs.rmSync(distPath, { recursive: true, force: true });
    console.log(chalk.green('✓ 已删除 dist'));
  }

  /**
   * 执行构建
   */
  async build(progressCallback, options = {}) {
    const shouldAbort = options.shouldAbort || (() => false);
    this.cleanDistFolder();
    const cmd = this.config.buildCommand || 'npm run build:secure';
    console.log(chalk.cyan(`\n🔨 开始构建（含混淆）: ${cmd}`));

    if (progressCallback) {
      progressCallback('build', 40, '🔨 正在构建并混淆项目...');
    }

    const startTime = Date.now();

    // 模拟构建进度（每15秒更新一次）；build:secure 含混淆，预估总时长略长
    const progressInterval = setInterval(async () => {
      if (shouldAbort()) {
        this.killActiveCommand();
        return;
      }
      const elapsed = (Date.now() - startTime) / 1000;
      const estimatedTotal = 300;
      const percent = 40 + Math.min(30, Math.floor((elapsed / estimatedTotal) * 30));

      if (progressCallback) {
        await progressCallback('build', percent, `🔨 正在构建并混淆... ${Math.floor(elapsed)}s`);
      }
    }, 15000);

    if (shouldAbort()) {
      clearInterval(progressInterval);
      throw new Error('BUILD_ABORTED');
    }

    const result = await this.runCommand(cmd);
    clearInterval(progressInterval);

    if (result.aborted || result.error === 'BUILD_ABORTED') {
      throw new Error('BUILD_ABORTED');
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    if (!result.success) {
      throw new Error(`构建失败: ${result.error}`);
    }

    console.log(chalk.green(`✓ 构建与混淆完成 (耗时 ${duration}s)`));
    return { duration };
  }

  /**
   * 打包 dist 文件夹为 .rar（WinRAR）
   */
  async packDist(branchName, progressCallback) {
    console.log(chalk.cyan('\n📦 打包文件（RAR）...'));

    const distPath = path.join(this.projectPath, this.config.distPath);

    if (!fs.existsSync(distPath)) {
      throw new Error(`构建输出目录不存在: ${distPath}`);
    }

    const zipOut = this.config.zipOutputPath;
    const buildsDir = path.isAbsolute(zipOut)
      ? zipOut
      : path.resolve(__dirname, '..', '..', zipOut);
    if (!fs.existsSync(buildsDir)) {
      fs.mkdirSync(buildsDir, { recursive: true });
    }

    const safeBranchName = branchName.replace(/[\/\\:*?"<>|]/g, '-');
    const archiveFileName = `${safeBranchName}.rar`;
    const archiveFilePath = path.join(buildsDir, archiveFileName);

    console.log(chalk.gray('RAR 压缩 dist（WinRAR 默认）...'));

    if (progressCallback) {
      await progressCallback('compress', 72, '📦 正在 RAR 压缩 dist...');
    }

    const { sizeMB } = await packDistWithRar({
      distPath,
      archiveFilePath,
      cwd: this.projectPath,
    });

    console.log(chalk.green(`✓ 打包完成: ${archiveFileName} (${sizeMB} MB)`));

    if (progressCallback) {
      await progressCallback('package', 80, `✓ 打包完成 ${sizeMB}MB`);
    }

    return {
      archiveFilePath,
      archiveFileName,
      sizeMB,
      // 兼容旧字段名
      zipFilePath: archiveFilePath,
      zipFileName: archiveFileName,
    };
  }

  /**
   * 在远端分支列表中按名称解析（不区分大小写）
   * @returns {Promise<string|null>} 仓库中的实际分支名
   */
  async resolveRemoteBranchName(branchInput) {
    const clean = (branchInput || '').trim().replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '');
    if (!clean) return null;

    if (!this._branchesCache) {
      try {
        this._branchesCache = await this.getBranches();
      } catch {
        this._branchesCache = [];
      }
    }

    const foundLocal = this._branchesCache.find((b) => {
      const cleanB = b.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '').trim();
      return cleanB.toLowerCase() === clean.toLowerCase();
    });
    if (foundLocal) {
      return foundLocal.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '').trim();
    }

    const lsResult = await this.runCommand('git ls-remote --heads origin');
    if (!lsResult.success || !lsResult.output) return null;

    const lower = clean.toLowerCase();
    for (const line of lsResult.output.split('\n')) {
      const m = line.match(/refs\/heads\/(\S+)/);
      if (!m || !m[1]) continue;
      const name = m[1].trim();
      if (name.toLowerCase() === lower) return name;
    }
    return null;
  }

  /**
   * 完整构建流程
   * @param {object} [options]
   * @param {(ctx: { branchName: string, commitInfo: string, projectPath: string }) => Promise<void>} [options.afterCheckout]
   */
  async fullBuild(branchName, progressCallback, options = {}) {
    const shouldAbort = options.shouldAbort || (() => false);
    const assertNotAborted = () => {
      if (shouldAbort()) {
        throw new Error('BUILD_ABORTED');
      }
    };

    try {
      console.log(chalk.bold.cyan('\n' + '='.repeat(50)));
      console.log(chalk.bold.cyan(`🚀 开始构建流程: ${branchName}`));
      console.log(chalk.bold.cyan('='.repeat(50) + '\n'));

      const startTime = Date.now();

      // 进度回调函数
      const updateProgress = async (stage, percent, message) => {
        assertNotAborted();
        if (progressCallback) {
          await progressCallback(stage, percent, message);
        }
      };

      // 1. 检查项目
      await updateProgress('check', 5, '🔍 检查项目目录...');
      this.checkProjectExists();
      assertNotAborted();

      // 2. 切换分支并拉取
      await updateProgress('fetch', 10, '📥 切换分支并拉取代码...');
      const { commitInfo } = await this.checkoutAndPull(branchName);
      assertNotAborted();

      if (typeof options.afterCheckout === 'function') {
        await options.afterCheckout({
          branchName,
          commitInfo,
          projectPath: this.projectPath,
        });
      }
      assertNotAborted();

      // 3. 安装依赖
      await updateProgress('install', 30, '📦 检查并安装依赖...');
      await this.installDependencies();
      assertNotAborted();

      // 4. 构建（含混淆：build:secure = npm run build && node obfuscate.js，runCommand 会等待整条命令结束）
      await updateProgress('build', 40, '🔨 开始构建并混淆项目...');
      const { duration: buildDuration } = await this.build(updateProgress, { shouldAbort });
      assertNotAborted();

      // 5. 打包文件
      await updateProgress('package', 70, '📦 开始打包文件...');
      const { archiveFilePath, archiveFileName, sizeMB } = await this.packDist(
        branchName,
        updateProgress,
      );
      assertNotAborted();

      const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);

      console.log(chalk.bold.green('\n' + '='.repeat(50)));
      console.log(chalk.bold.green('✅ 构建成功！'));
      console.log(chalk.bold.green('='.repeat(50) + '\n'));

      return {
        success: true,
        branchName,
        commitInfo,
        buildDuration,
        totalDuration,
        zipFilePath: archiveFilePath,
        zipFileName: archiveFileName,
        archiveFilePath,
        archiveFileName,
        sizeMB
      };

    } catch (error) {
      if (error.message === 'BUILD_ABORTED') {
        console.log(chalk.yellow('\n⏹ 构建已终止\n'));
        return {
          success: false,
          error: 'BUILD_ABORTED',
        };
      }

      console.log(chalk.bold.red('\n' + '='.repeat(50)));
      console.log(chalk.bold.red('❌ 构建失败！'));
      console.log(chalk.bold.red('='.repeat(50) + '\n'));
      console.error(chalk.red(error.message));

      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = Builder;

