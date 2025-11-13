const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const chalk = require('chalk');

class FileSplitter {
  /**
   * 分割文件
   * @param {string} filePath - 原文件路径
   * @param {number} chunkSizeMB - 每片大小（MB）
   * @returns {Promise<Array>} - 返回分片文件路径数组
   */
  static async splitFile(filePath, chunkSizeMB = 50) {
    const chunkSize = chunkSizeMB * 1024 * 1024; // 转换为字节
    const fileSize = fs.statSync(filePath).size;
    const fileName = path.basename(filePath, path.extname(filePath));
    const fileDir = path.dirname(filePath);

    // 计算需要分成几片
    const totalChunks = Math.ceil(fileSize / chunkSize);

    console.log(chalk.cyan(`\n📦 文件分片:`));
    console.log(chalk.gray(`  文件大小: ${(fileSize / 1024 / 1024).toFixed(2)} MB`));
    console.log(chalk.gray(`  分片大小: ${chunkSizeMB} MB`));
    console.log(chalk.gray(`  分片数量: ${totalChunks} 片\n`));

    const chunkFiles = [];

    return new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(filePath);
      let chunkIndex = 0;
      let currentChunkPath = null;
      let currentWriteStream = null;
      let currentChunkSize = 0;

      readStream.on('data', (chunk) => {
        // 需要创建新分片
        if (!currentWriteStream) {
          chunkIndex++;
          const chunkFileName = totalChunks > 1
            ? `${fileName}.part${chunkIndex}.zip`
            : `${fileName}.zip`;
          currentChunkPath = path.join(fileDir, chunkFileName);
          currentWriteStream = fs.createWriteStream(currentChunkPath);
          currentChunkSize = 0;

          chunkFiles.push({
            path: currentChunkPath,
            name: chunkFileName,
            part: chunkIndex,
            total: totalChunks
          });

          console.log(chalk.gray(`  创建第 ${chunkIndex}/${totalChunks} 片...`));
        }

        // 检查是否会超出分片大小
        if (currentChunkSize + chunk.length > chunkSize) {
          // 计算本片还能写入多少
          const remainingSpace = chunkSize - currentChunkSize;

          if (remainingSpace > 0) {
            // 写入剩余空间
            currentWriteStream.write(chunk.slice(0, remainingSpace));
          }

          // 关闭当前分片
          currentWriteStream.end();
          currentWriteStream = null;

          // 如果还有剩余数据，创建新分片并写入
          if (chunk.length > remainingSpace) {
            chunkIndex++;
            const chunkFileName = `${fileName}.part${chunkIndex}.zip`;
            currentChunkPath = path.join(fileDir, chunkFileName);
            currentWriteStream = fs.createWriteStream(currentChunkPath);
            currentChunkSize = 0;

            chunkFiles.push({
              path: currentChunkPath,
              name: chunkFileName,
              part: chunkIndex,
              total: totalChunks
            });

            console.log(chalk.gray(`  创建第 ${chunkIndex}/${totalChunks} 片...`));

            // 写入剩余部分
            const remainingData = chunk.slice(remainingSpace);
            currentWriteStream.write(remainingData);
            currentChunkSize = remainingData.length;
          }
        } else {
          // 直接写入整个 chunk
          currentWriteStream.write(chunk);
          currentChunkSize += chunk.length;
        }
      });

      readStream.on('end', () => {
        if (currentWriteStream) {
          currentWriteStream.end();
        }

        console.log(chalk.green(`✓ 分片完成，共 ${chunkFiles.length} 片\n`));
        resolve(chunkFiles);
      });

      readStream.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * 清理分片文件
   * @param {Array} chunkFiles - 分片文件信息数组
   */
  static cleanupChunks(chunkFiles) {
    chunkFiles.forEach(chunk => {
      try {
        if (fs.existsSync(chunk.path)) {
          fs.unlinkSync(chunk.path);
        }
      } catch (e) {
        console.error(chalk.yellow(`清理分片文件失败: ${chunk.name}`));
      }
    });
  }
}

module.exports = FileSplitter;

