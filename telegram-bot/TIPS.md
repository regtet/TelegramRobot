# 使用建议和最佳实践

## 🎯 日常使用建议

### 1. 启动方式

#### 开发/测试阶段
```powershell
cd telegram-bot
npm start
```
这样可以看到实时日志，方便调试。

#### 生产环境（推荐）
使用 PM2 后台运行：
```powershell
npm install -g pm2
pm2 start index-user.js --name wg-builder
pm2 save
pm2 startup  # 开机自启
```

查看日志：
```powershell
pm2 logs wg-builder
```

---

### 2. 网络优化

#### 如果网络稳定
保持默认配置，自动拉取最新代码：
```javascript
autoFetchPull: true
```

#### 如果网络不稳定
关闭自动拉取，只用本地代码：
```javascript
autoFetchPull: false
```

**注意：** 关闭后需要手动在 WG-WEB 目录切换分支并 pull

---

### 3. 安全配置

#### 限制可使用的用户
`.env` 文件中：
```env
ALLOWED_USERS=123456789,987654321
```

获取用户ID：查看控制台日志，有人发消息时会显示。

#### 限制可打包的分支
`config.js` 中：
```javascript
allowedBranches: ['main', 'dev', 'release']
```

这样可以防止误操作打包错误的分支。

---

### 4. 性能优化

#### 关闭自动 npm install
如果依赖很少变化，可以关闭自动安装：
```javascript
autoInstall: false
```

这样可以节省每次打包的时间（1-2分钟）。

**注意：** package.json 更新后需要手动 `npm install`

#### 清理构建缓存
定期清理 builds 目录：
```powershell
cd telegram-bot/builds
rm *.zip
```

---

## 📋 工作流程建议

### 方案 A：完全自动化（推荐）
```
开发 → 提交代码到 Git → Telegram 发送分支名 → 自动打包并发送
```

**优点：**
- ✅ 全自动，不需要手动操作
- ✅ 确保打包的是最新代码

**配置：**
```javascript
autoFetchPull: true
autoInstall: true
```

---

### 方案 B：半自动化（网络不稳定时）
```
开发 → 提交代码 → 手动 pull → Telegram 发送分支名 → 打包本地代码
```

**优点：**
- ✅ 不依赖网络
- ✅ 打包速度快

**配置：**
```javascript
autoFetchPull: false
autoInstall: false
```

**操作步骤：**
```powershell
cd WG-WEB
git checkout <分支名>
git pull
# 然后在 Telegram 发送分支名
```

---

## 🔒 安全建议

### 1. 保护敏感信息
- ✅ 不要把 `.env` 文件提交到 Git
- ✅ 不要把 `session.txt` 分享给别人
- ✅ 不要公开你的 API_ID 和 API_HASH

### 2. 定期更换凭证
如果怀疑账号泄露：
1. 删除 `session.txt`
2. 重新登录
3. 或者在 https://my.telegram.org/apps 重新创建应用

### 3. 使用专用测试群组
- 不要在重要群组使用
- 可以创建一个专门的测试群组
- 只邀请需要的人

---

## 📊 监控和日志

### 实时监控
```powershell
# 如果用 PM2
pm2 logs wg-builder --lines 100

# 如果直接运行
# 控制台会显示所有日志
```

### 关键日志
```
✓ 已连接到 Telegram        # 连接成功
收到消息: <分支名>           # 收到打包请求
开始打包分支: <分支名>        # 开始打包
✓ 构建完成                  # 构建成功
✓ 文件发送成功              # 文件发送成功
```

---

## 🐛 常见问题

### 1. 打包失败
**检查：**
- WG-WEB 项目本身是否能构建成功
- 依赖是否安装完整
- Node 版本是否符合要求

**解决：**
```powershell
cd WG-WEB
npm install
npm run build  # 手动测试
```

### 2. 文件发送失败
**检查：**
- 网络连接是否正常
- 代理是否还在运行
- 文件是否太大（>2GB）

### 3. 验证码收不到
**解决：**
- 检查代理配置
- 确认代理端口正确
- 使用 `get-session.js` 在其他环境获取 session

### 4. 打包队列繁忙
**正常现象：** 说明有其他打包正在进行
**等待：** 当前打包完成后自动可以继续

---

## 🔧 维护建议

### 每周
- ✅ 检查磁盘空间（builds 目录）
- ✅ 查看日志是否有异常

### 每月
- ✅ 更新依赖：`npm update`
- ✅ 清理旧的 zip 文件
- ✅ 检查 session 是否正常

### 遇到问题时
1. 查看控制台/PM2 日志
2. 检查网络连接
3. 重启程序
4. 如果还不行，删除 session.txt 重新登录

---

## 💡 高级技巧

### 1. 自定义构建命令
`config.js` 中：
```javascript
buildCommand: 'npm run build:prod'  // 使用特定的构建命令
```

### 2. 多环境配置
可以创建多个 `.env` 文件：
```
.env.dev      # 开发环境
.env.prod     # 生产环境
.env.test     # 测试环境
```

使用时：
```powershell
cp .env.prod .env
npm start
```

### 3. 自动通知
打包完成后自动通知特定用户（可扩展功能）

### 4. 打包队列
如果需要支持多个并发打包，可以改用队列系统（需要额外开发）

---

## 📝 总结

**简单使用：**
```
1. 启动：npm start
2. 发送：分支名
3. 等待：接收文件
```

**最佳实践：**
- ✅ 使用 PM2 后台运行
- ✅ 限制用户和分支权限
- ✅ 定期检查日志和清理文件
- ✅ 根据网络情况调整配置

**安全第一：**
- ⚠️ 保护好 .env 和 session.txt
- ⚠️ 不要在公开群组使用
- ⚠️ 定期检查账号安全

---

有问题随时查看日志或重启程序！🚀

