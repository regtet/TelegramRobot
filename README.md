# WG-WEB Telegram 自动打包机器人

通过 Telegram 消息触发 WG-WEB 项目的自动打包（ZIP）、APK 打包与 S3 分发。采用**双机器人**架构：用户账号机器人（User Bot）负责实际构建与发文件，常规 Bot 负责 APK 待办列表与快捷操作。

**⚠️ 当前使用用户账号模式（User Bot），可发送最大 2GB 的文件！**

---

## 功能概览

### 用户机器人（index-user.js）

- 📦 发送「打包 分支名」触发 ZIP 打包并发送到群
- 📱 发送「打包APK 分支名」或点击 Bot 的「立即打包 APK」触发 APK 构建
- 🚀 自动拉取最新代码、执行构建、上传 APK 到 S3，并在群里发送结果（含新格式：分支 | apk 文件名 | Logo/APK 地址）
- 🔐 仅处理 `.env` 中 `CHAT_ID` 指定群组的消息
- 🌐 代理、AWS S3、打包服务（47.128.239.172:8000）均按当前配置工作

### 常规 Bot（index.js，如 @kk_toolbox_bot）

- 📋 **等待打包 APK 列表**：上传压缩包（可选）弹出「是否打包 APK」二选一；超时或选择后写入 `apk-pending.json`
- 📤 监听到「✅ APK 打包完成」消息时，从列表中移除对应分支（支持新格式 `✅ APK 打包完成 | 分支 | apk 名`）
- 🕐 每天凌晨 5 点自动执行一次「一键触发所有等待打包 APK」（/apk_start_all），并发送提醒
- 📊 `/apk_start_all` 后，全部完成时在群里发送统计：成功 x 条、失败 x 条（含分支名）

### Bot 命令（群组 / 私聊）

| 命令 | 说明 |
|------|------|
| `/help` | 显示 APK 助手命令列表 |
| `/apk_list` | 查看等待打包 APK 列表 |
| `/apk_add 分支1 分支2 ...` | 手动添加等待打包 APK 分支 |
| `/apk_del 分支1 分支2 ...` | 从列表中删除指定分支 |
| `/apk_start_all` | 一键触发当前列表中所有分支的「打包APK」流程 |
| `/apk_clear` | 清空等待打包 APK 列表 |

私聊 Bot 时，`/apk_list`、`/apk_add`、`/apk_del` 同样可用。

---

## 安装与配置

### 1. 安装依赖

```bash
cd telegram-bot
yarn
# 或 npm install
```

### 2. 获取 Telegram 凭证

- **用户机器人**：访问 https://my.telegram.org/apps 获取 `API_ID`、`API_HASH`，并用手机号登录。
- **常规 Bot**：在 Telegram 中找 @BotFather 创建 Bot，获取 `BOT_TOKEN`。

### 3. 配置 .env

在 `telegram-bot` 目录下编辑 `.env`：

```env
# 常规 Bot（APK 列表、命令、凌晨任务）
BOT_TOKEN=你的Bot_Token
BOT_CHAT_ID=-100xxxxxxxx   # Bot 监听的群组 ID（可与 CHAT_ID 不同）

# 用户机器人（实际打包、发文件）
API_ID=你的api_id
API_HASH=你的api_hash
PHONE_NUMBER=+86xxxxxxxxxx
CHAT_ID=-100xxxxxxxx       # 用户机器人只处理该群消息

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
- 若需关闭「上传压缩包后弹出是否打包 APK 按钮」，在 `.env` 中增加：`ENABLE_ZIP_INTERACTIVE=0`（默认开启）。

### 4. 获取群组 ID

1. 启动：`yarn dev` 或 `npm run dev`
2. 在目标群发一条消息
3. 控制台会打印该群的 `群组ID`，填入 `.env` 的 `CHAT_ID`（用户机器人）和/或 `BOT_CHAT_ID`（Bot）

---

## 启动方式

在 `telegram-bot` 目录下：

```bash
# 同时启动用户机器人 + 常规 Bot（推荐）
yarn dev

# 仅启动用户机器人
yarn dev:user

# 仅启动常规 Bot
yarn dev:bot
```

`nodemon` 会监听 `.js` 变更自动重启；`session.txt`、`apk-pending.json` 已加入忽略，避免误触重启。

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

- **apk-pending.json**：等待打包 APK 的分支列表（Bot 维护）。成功消息识别后会按分支移除；分支名大小写不敏感。该文件已加入 `.gitignore`，不提交版本库。
- **session.txt**：用户机器人的 Telegram 会话，首次登录后生成，勿提交。

---

## 项目结构（telegram-bot）

```
telegram-bot/
├── index-user.js      # 用户机器人：打包 ZIP/APK、S3、群消息处理
├── index.js            # 常规 Bot：APK 列表、命令、按钮、凌晨任务、统计
├── apk-tracker.js      # 等待打包 APK 列表的读写（apk-pending.json）
├── config-reader.js    # 从分支/文件名解析配置（如 extractBranchNameFromFileName）
├── config.js           # 配置聚合（.env + 构建选项）
├── builder.js          # 构建逻辑（git/npm/zip）
├── .env                # 环境变量（不提交）
├── nodemon.json        # 忽略 session.txt、apk-pending.json 等
├── package.json
└── builds/             # 临时 zip 输出（可清理）
```

---

## 常见问题

1. **Bot 收不到群消息**
   - 在 @BotFather 中对该 Bot 执行 `/setprivacy` → 选 Disable，并把 Bot 移出群后重新拉入。
2. **47.128.239.172 请求超时 / ECONNRESET**
   - 代码已对 pack/list/download 使用显式代理（127.0.0.1:7890），请确保本机代理已开启且端口一致。
3. **执行 /apk_start_all 后 json 未清除**
   - Bot 通过识别「✅ APK 打包完成」类消息移除对应分支；若成功消息格式变更，需在 `index.js` 的 `extractBranchFromApkMessage` 中兼容新格式（当前已支持「打包完成 | 分支 | apk 名」）。
4. **S3 上传失败**
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
