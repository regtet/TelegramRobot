# WG-WEB Telegram 自动打包机器人

通过 Telegram 消息触发 WG-WEB 项目的自动打包（ZIP）、APK 打包与 S3 分发。当前为**单用户号**架构：入口 `index.js` 负责构建、APK 队列、压缩包检测与 `/apk_*` 命令。

**⚠️ 当前使用用户账号模式（User Bot），可发送最大 2GB 的文件！**

---

## 功能概览

### 用户机器人（index.js）

- 📦 发送「打包 分支名」触发 ZIP 打包并发送到群
- 📱 发送「打包APK 分支名」触发 APK 构建；`/apk_start_all` 一键打包等待队列
- 📋 上传压缩包 → 自动配置检测 + 写入 `apk-pending.json`；APK 成功后自动移出队列
- 🕐 每天凌晨 4 点自动打包等待队列（`.env` 中 `ENABLE_APK_CRON=false` 可关闭）
- 🚀 自动拉取最新代码、执行构建、上传 APK 到 S3，并在群里发送结果
- 🔐 处理 `.env` 中 `CHAT_ID` / `CHAT_IDS` 指定群组的消息

### APK 队列命令（在群内对你的用户号发送）

| 命令 | 说明 |
|------|------|
| `/help` | 显示 APK 助手命令列表 |
| `/apk_list` | 查看等待打包 APK 列表 |
| `/apk_add 分支1 分支2 ...` | 手动添加分支 |
| `/apk_del 分支1 分支2 ...` | 从列表删除 |
| `/apk_start_all` | 一键打包队列中全部分支 |
| `/apk_clear` | 清空列表 |

---

## 安装与配置

### 1. 安装依赖

```bash
cd telegram-bot
yarn
# 或 npm install
```

### 2. 获取 Telegram 凭证

- 访问 https://my.telegram.org/apps 获取 `API_ID`、`API_HASH`，并用手机号登录。

### 3. 配置 .env

复制模板并填写：

```bash
cp .env.example .env
```

```env
API_ID=你的api_id
API_HASH=你的api_hash
PHONE_NUMBER=+86xxxxxxxxxx
CHAT_ID=-100xxxxxxxx

# 代理（用户机器人与 Bot 均使用；国内必填）
PROXY_TYPE=5
PROXY_HOST=127.0.0.1
PROXY_PORT=7890

# 项目路径
BUILD_PROJECT_PATH=../WG-WEB
# BUILD_PROJECT_PATH_B=../WGAME-WEB   # 可选第二仓库
ALLOWED_USERS=                        # 可选，逗号分隔用户 ID

# AWS S3（APK 上传）
AWS_ACCESS_KEY_ID=xxx
AWS_SECRET_ACCESS_KEY=xxx
AWS_REGION=sa-east-1
S3_BUCKET=你的bucket
```

- 访问打包服务 `http://47.128.239.172:8000` 的请求（触发打包、查询 /list、下载 APK）在代码中已配置为**显式代理**（127.0.0.1:7890），与浏览器/测试脚本一致。
- 开关均在 `.env` 使用 `true` / `false`，例如 `ENABLE_ZIP_PENDING=false` 关闭压缩包入队，`ENABLE_LOG_ALL_MESSAGES=true` 调试 chatId。

### 4. 获取群组 ID

1. 启动：`yarn dev` 或 `npm run dev`
2. 在目标群发一条消息
3. 控制台会打印该群的 `群组ID`，填入 `.env` 的 `CHAT_ID` 或 `CHAT_IDS`

---

## 启动方式

在 `telegram-bot` 目录下：

```bash
yarn dev
# 或
yarn start
```

`nodemon` 会监听入口与 `lib/`；`data/`、`var/` 运行时目录已忽略，避免误触重启。

---

## 用户机器人命令（在 CHAT_ID 群内）

| 输入 | 说明 |
|------|------|
| `/start` | 显示帮助 |
| `/status` | 配置状态 |
| `/branches` | 可用分支列表 |
| `/queue` | 当前打包队列 |
| `打包 分支1 分支2` | 打包 ZIP 并发送 |
| `打包APK 分支1 分支2` | 加入 APK 打包流程（构建 + 上传 S3 + 发结果到群） |
| `取消 分支` / `取消打包 分支` | 取消该分支的打包 |

---

## 数据文件说明

- **data/apk-pending.json**：等待打包 APK 的分支列表。批量汇总后会清除本批；分支名大小写不敏感。不提交版本库。
- **data/session.txt**：Telegram 会话，首次登录后生成，勿提交。
- **data/branch-package-expect.json**：分包公告期望配置（可按需纳入版本库）。
- **var/builds/**：ZIP 构建输出（可定期清理）。
- **var/logs/**、**var/tmp/**：运行日志与临时文件。

---

## 项目结构（telegram-bot）

```
telegram-bot/
├── index.js                # 入口（index-user.js 为兼容转发，可忽略）
├── lib/
│   ├── paths.js            # data/、var/ 路径与旧版迁移
│   ├── apk/                # apk-pending、批量逻辑
│   ├── branch/             # 公告解析、分包期望
│   ├── build/              # git / npm / zip 构建
│   ├── core/               # 配置读取、群消息过滤
│   └── logging/            # 运行日志
├── data/                   # 持久化 JSON、session
├── var/                    # logs、tmp、builds
├── docs/                   # TIPS、优化说明
├── scripts/get-session.js
└── .env.example
```

---

## 常见问题

1. **47.128.239.172 请求超时 / ECONNRESET**
   - 代码已对 pack/list/download 使用显式代理（127.0.0.1:7890），请确保本机代理已开启且端口一致。
2. **执行 /apk_start_all 后 pending 未清除**
   - 用户号识别「✅ APK 打包完成」且带 `APK地址:` 后移除；格式变更时请改 `lib/apk/apk-pending-admin.js`。
3. **S3 上传失败**
   - 检查 `.env` 中 AWS 密钥、Region、Bucket 是否正确；S3 上传未走 47.128 代理，走直连。

---

## 安全与维护

- 不要将 `.env`、`session.txt`、`apk-pending.json` 提交到 Git。
- 建议设置 `ALLOWED_USERS` 限制可触发打包的用户。
- 更新依赖：`yarn` / `npm update`。
- 清理构建产物：`rm -rf builds/*.zip`（按需）。
- 功能持续更新-后续md文件不会更新了。
---

## License

MIT
