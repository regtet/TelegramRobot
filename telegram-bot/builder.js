const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const chalk = require('chalk');

const execAsync = promisify(exec);

// 是否打印每条 shell 命令的详细日志（默认关闭，避免刷屏）
// 需要排查时可临时设置环境变量 ENABLE_COMMAND_LOG=1
const ENABLE_COMMAND_LOG = process.env.ENABLE_COMMAND_LOG === '1';

class Builder {
  constructor(projectPath, config) {
    this.projectPath = path.resolve(__dirname, projectPath);
    this.config = config;
  }

  /**
   * 执行命令并返回结果
   */
  async runCommand(command, cwd = this.projectPath) {
    if (ENABLE_COMMAND_LOG) {
      console.log(chalk.blue(`执行命令: ${command}`));
      console.log(chalk.gray(`工作目录: ${cwd}`));
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        maxBuffer: 10 * 1024 * 1024 // 10MB
      });

      if (ENABLE_COMMAND_LOG && stderr && !stderr.includes('warning')) {
        console.log(chalk.yellow('警告:'), stderr);
      }

      return { success: true, output: stdout };
    } catch (error) {
      // 失败始终输出，便于定位问题
      console.error(chalk.red('命令执行失败:'), error.message);
      return { success: false, error: error.message };
    }
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
  async validateBranches(branchNames) {
    // 清除缓存，确保获取最新分支列表
    this._branchesCache = null;

    try {
      this._branchesCache = await this.getBranches();
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
        result = await this.runCommand('git fetch --all');
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

    // 1.5. 清理工作区，确保可以切换分支
    console.log(chalk.cyan('🧹 清理工作区...'));

    // 检查工作区状态
    result = await this.runCommand('git status --porcelain');
    const hasChanges = result.success && result.output.trim().length > 0;

    if (hasChanges) {
      console.log(chalk.yellow('⚠ 检测到工作区有未提交的更改，正在清理...'));

      // 重置工作区和索引（丢弃所有本地更改）
      result = await this.runCommand('git reset --hard HEAD');
      if (!result.success) {
        console.log(chalk.yellow('⚠ git reset --hard 失败，尝试其他方法...'));
      }

      // 清理未跟踪的文件和目录
      const cleanResult = await this.runCommand('git clean -fd');
      if (cleanResult.success) {
        console.log(chalk.green('✓ 工作区已清理'));
      } else if (result.success) {
        console.log(chalk.green('✓ 工作区已清理（部分）'));
      } else {
        console.log(chalk.yellow('⚠ 工作区清理可能不完整，继续尝试切换分支...'));
      }
    } else {
      console.log(chalk.green('✓ 工作区干净'));
    }

    // 2. 切换分支
    result = await this.runCommand(`git checkout ${branchName}`);
    if (!result.success) {
      // 如果切换失败，尝试强制切换
      console.log(chalk.yellow('⚠ 普通切换失败，尝试强制切换...'));
      result = await this.runCommand(`git checkout -f ${branchName}`);

      if (!result.success) {
        throw new Error(`切换分支失败: ${result.error}`);
      }
    }
    console.log(chalk.green(`✓ 已切换到 ${branchName}`));

    // 3. Pull 最新代码（带重试）
    if (this.config.autoFetchPull) {
      for (let i = 0; i < retries; i++) {
        result = await this.runCommand('git pull');
        if (result.success) break;

        if (i < retries - 1) {
          console.log(chalk.yellow(`⚠ Pull 失败，${3 - i} 秒后重试... (${i + 1}/${retries})`));
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }

      if (!result.success) {
        throw new Error(`拉取代码失败: ${result.error}\n\n💡 请检查网络连接或稍后重试`);
      }
      console.log(chalk.green('✓ 代码已更新'));
    } else {
      console.log(chalk.yellow('⚠ 跳过 Pull（autoFetchPull=false）'));
      console.log(chalk.cyan('使用本地已有代码'));
    }

    // 4. 获取最新 commit 信息
    result = await this.runCommand('git log -1 --pretty=format:"%h - %s (%an, %ar)"');
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

  /**
   * 执行构建
   */
  async build(progressCallback) {
    console.log(chalk.cyan('\n🔨 开始构建...'));

    if (progressCallback) {
      progressCallback('build', 40, '🔨 正在构建项目...');
    }

    const startTime = Date.now();

    // 模拟构建进度（每15秒更新一次，确保能看到）
    const progressInterval = setInterval(async () => {
      const elapsed = (Date.now() - startTime) / 1000;
      // 构建通常需要2-3分钟，估算进度
      const estimatedTotal = 180; // 预估180秒
      const percent = 40 + Math.min(30, Math.floor((elapsed / estimatedTotal) * 30));

      if (progressCallback) {
        await progressCallback('build', percent, `🔨 正在构建项目... ${Math.floor(elapsed)}s`);
      }
    }, 15000);  // 15秒更新一次

    const result = await this.runCommand(this.config.buildCommand);
    clearInterval(progressInterval);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    if (!result.success) {
      throw new Error(`构建失败: ${result.error}`);
    }

    console.log(chalk.green(`✓ 构建完成 (耗时 ${duration}s)`));
    return { duration };
  }

  /**
   * 打包 dist 文件夹
   */
  async zipDist(branchName, progressCallback) {
    console.log(chalk.cyan('\n📦 打包文件...'));

    const distPath = path.join(this.projectPath, this.config.distPath);

    // 检查 dist 目录是否存在
    if (!fs.existsSync(distPath)) {
      throw new Error(`构建输出目录不存在: ${distPath}`);
    }

    // 创建 builds 目录
    const buildsDir = path.resolve(__dirname, this.config.zipOutputPath);
    if (!fs.existsSync(buildsDir)) {
      fs.mkdirSync(buildsDir, { recursive: true });
    }

    // 生成文件名：分支名.zip
    // 替换分支名中的非法字符（Windows 文件名不能包含 / \ : * ? " < > |）
    const safeBranchName = branchName.replace(/[\/\\:*?"<>|]/g, '-');

    const zipFileName = `${safeBranchName}.zip`;
    const zipFilePath = path.join(buildsDir, zipFileName);

    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipFilePath);
      const compressionLevel = this.config.compressionLevel || 6;
      const archive = archiver('zip', { zlib: { level: compressionLevel } });

      console.log(chalk.gray(`压缩级别: ${compressionLevel}/9`));

      // 获取需要压缩的总大小
      let totalBytes = 0;
      let processedBytes = 0;

      // 计算总大小
      const calculateSize = (dir) => {
        const files = fs.readdirSync(dir);
        files.forEach(file => {
          const filePath = path.join(dir, file);
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            calculateSize(filePath);
          } else {
            totalBytes += stat.size;
          }
        });
      };
      calculateSize(distPath);

      // 监听压缩进度（降低更新频率）
      let lastProgressUpdate = 0;
      archive.on('progress', async (progress) => {
        processedBytes = progress.fs.processedBytes;
        const percent = 70 + Math.floor((processedBytes / totalBytes) * 10);
        const processedMB = (processedBytes / 1024 / 1024).toFixed(1);
        const totalMB = (totalBytes / 1024 / 1024).toFixed(1);

        // 每20%更新一次，避免太频繁
        if (percent - lastProgressUpdate >= 2 || percent >= 80) {
          lastProgressUpdate = percent;

          if (progressCallback) {
            await progressCallback('compress', percent, `📦 正在打包... ${processedMB}MB/${totalMB}MB`);
          }
        }
      });

      output.on('close', async () => {
        const sizeMB = (archive.pointer() / 1024 / 1024).toFixed(2);
        console.log(chalk.green(`✓ 打包完成: ${zipFileName} (${sizeMB} MB)`));

        if (progressCallback) {
          await progressCallback('package', 80, `✓ 打包完成 ${sizeMB}MB`);
        }

        resolve({ zipFilePath, zipFileName, sizeMB });
      });

      archive.on('error', (err) => {
        reject(err);
      });

      archive.pipe(output);
      archive.directory(distPath, 'dist');  // 包含 dist 文件夹
      archive.finalize();
    });
  }

  /**
   * 完整构建流程
   */
  async fullBuild(branchName, progressCallback) {
    try {
      console.log(chalk.bold.cyan('\n' + '='.repeat(50)));
      console.log(chalk.bold.cyan(`🚀 开始构建流程: ${branchName}`));
      console.log(chalk.bold.cyan('='.repeat(50) + '\n'));

      const startTime = Date.now();

      // 进度回调函数
      const updateProgress = async (stage, percent, message) => {
        if (progressCallback) {
          await progressCallback(stage, percent, message);
        }
      };

      // 1. 检查项目
      await updateProgress('check', 5, '🔍 检查项目目录...');
      this.checkProjectExists();

      // 2. 切换分支并拉取
      await updateProgress('fetch', 10, '📥 切换分支并拉取代码...');
      const { commitInfo } = await this.checkoutAndPull(branchName);

      // 3. 安装依赖
      await updateProgress('install', 30, '📦 检查并安装依赖...');
      await this.installDependencies();

      // 4. 构建
      await updateProgress('build', 40, '🔨 开始构建项目...');
      const { duration: buildDuration } = await this.build(updateProgress);

      // 5. 打包文件
      await updateProgress('package', 70, '📦 开始打包文件...');
      const { zipFilePath, zipFileName, sizeMB } = await this.zipDist(branchName, updateProgress);

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
        zipFilePath,
        zipFileName,
        sizeMB
      };

    } catch (error) {
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

