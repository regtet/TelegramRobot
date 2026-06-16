/**
 * APK 相关的纯文本消息构建（无副作用、不依赖运行时状态）。
 * 从 index.js 抽出，便于复用与单测。
 */
const { errMsg } = require('../core/err');

/** 根据错误信息推断失败发生在哪个环节 */
function inferApkFailureStage(error) {
    const m = errMsg(error);
    if (/S3|AWS|amazonaws|PutObject|上传到 S3|socket hang up|TimeoutError/i.test(m)) return '上传 S3';
    if (/Telegram sendFile|Telegram sendMessage|Telegram 通知失败|整链超时/i.test(m)) return 'Telegram 发群';
    if (/未找到已打包|打包结果|\/list|访问 \/list/i.test(m)) return '等待打包结果';
    if (/下载 APK.*超时|下载.*超时/i.test(m)) return '下载 APK';
    if (/下载 APK|download/i.test(m)) return '下载 APK';
    if (/Logo|gulu_top/i.test(m)) return 'Logo 处理';
    if (/切换分支|checkout|git/i.test(m)) return 'Git 分支';
    return '';
}

/** APK 打包失败的群消息文案 */
function buildApkFailureTelegramMessage(projectName, branchName, error) {
    const errorMsg = errMsg(error);
    const stage = inferApkFailureStage(error);
    const stageLine = stage ? `🔧 环节: ${stage}\n` : '';
    return (
        `❌ APK 打包失败\n\n` +
        stageLine +
        `📁 项目: ${projectName}\n` +
        `🌿 分支: ${branchName}\n` +
        `📝 错误信息: ${errorMsg}`
    );
}

/** 批量 APK 打包统计文案 */
function buildApkBatchSummaryText(orderedBranches, outcomes, invalidBranches = []) {
    const successList = orderedBranches.filter((b) => outcomes.get(b) === 'success');
    const skippedList = orderedBranches.filter((b) => outcomes.get(b) === 'skipped');
    const failureFromBuild = orderedBranches.filter(
        (b) => outcomes.get(b) !== 'success' && outcomes.get(b) !== 'skipped',
    );
    const notFoundList = Array.isArray(invalidBranches)
        ? invalidBranches.map((b) => String(b).trim()).filter(Boolean)
        : [];
    const failureItems = [
        ...failureFromBuild.map((b) => ({ label: b, suffix: '' })),
        ...notFoundList.map((b) => ({
            label: b,
            suffix: '（仓库中不存在，已跳过）',
        })),
    ];

    const successCount = successList.length;
    const failureCount = failureItems.length;
    const skippedCount = skippedList.length;

    let summaryMsg = `📊 APK 批量打包统计\n\n✅ 成功 ${successCount} 条`;
    if (successList.length) {
        summaryMsg += '\n' + successList.map((b, i) => `${i + 1}. ${b}`).join('\n');
    }
    summaryMsg += `\n\n⏭️ 跳过（曾成功打包） ${skippedCount} 条`;
    if (skippedList.length) {
        summaryMsg += '\n' + skippedList.map((b, i) => `${i + 1}. ${b}`).join('\n');
    }
    summaryMsg += `\n\n❌ 失败 ${failureCount} 条`;
    if (failureItems.length) {
        summaryMsg +=
            '\n' +
            failureItems.map((item, i) => `${i + 1}. ${item.label}${item.suffix}`).join('\n');
    }
    if (failureFromBuild.length >= 3) {
        summaryMsg += '\n\n⚠️ 疑似打包服务异常，请检查服务器状态';
    }
    return summaryMsg;
}

module.exports = {
    inferApkFailureStage,
    buildApkFailureTelegramMessage,
    buildApkBatchSummaryText,
};
