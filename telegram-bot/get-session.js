/**
 * 辅助脚本：获取 Telegram Session String
 * 在能访问 Telegram 的环境中运行，获取 session 字符串
 */

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');
require('dotenv').config();

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const phoneNumber = process.env.PHONE_NUMBER;

console.log('='.repeat(50));
console.log('Telegram Session 获取工具');
console.log('='.repeat(50));
console.log();

if (!apiId || !apiHash) {
  console.error('错误: 请先在 .env 中配置 API_ID 和 API_HASH');
  process.exit(1);
}

(async () => {
  const client = new TelegramClient(
    new StringSession(''),
    apiId,
    apiHash,
    { connectionRetries: 5 }
  );

  await client.start({
    phoneNumber: async () => phoneNumber || await input.text('请输入手机号（带国家码）: '),
    password: async () => await input.text('请输入两步验证密码（如果有）: '),
    phoneCode: async () => await input.text('请输入验证码: '),
    onError: (err) => console.log(err),
  });

  console.log('\n✅ 登录成功！');

  const session = client.session.save();
  console.log('\n请复制以下 Session String 到目标设备的 session.txt 文件中:');
  console.log('\n' + '='.repeat(50));
  console.log(session);
  console.log('='.repeat(50));

  await client.disconnect();
})();













