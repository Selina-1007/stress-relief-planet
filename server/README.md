# 解压星球 - 后端服务器

社区中心功能的后端服务，包含用户系统、心情广场、实时群聊。

## 📁 文件结构

```
workspace/
├── stress-relief-planet.html    # 前端页面（所有解压功能 + 社区中心）
└── server/
    ├── package.json             # 依赖配置
    ├── server.js                # 主服务器（Express + Socket.IO）
    ├── db.js                    # 数据库初始化（SQLite）
    └── data.db                  # 数据库文件（首次运行自动生成）
```

## 🚀 启动方法

### 1. 安装依赖（首次运行需要）

```bash
cd server
npm install
```

### 2. 启动服务器

```bash
cd server
npm start
```

启动后会看到：
```
╔══════════════════════════════════════════════╗
║   解压星球 - 后端服务器已启动                  ║
║                                              ║
║   🌐  访问地址: http://localhost:3000          ║
║   🔌  WebSocket: ws://localhost:3000           ║
║   💾  数据库: SQLite (data.db)                ║
╚══════════════════════════════════════════════╝
```

### 3. 打开网站

在浏览器访问：**http://localhost:3000**

点击「社区中心」即可注册账号开始使用！

## ✨ 社区功能

### 🌆 心情广场
- 发布心情动态（可选择表情）
- 点赞 / 取消点赞
- 评论互动
- 实时收到新动态通知

### 💬 互助群聊
- 实时群聊（Socket.IO）
- 在线用户列表
- 加入/离开系统提示
- 历史消息记录

### 👤 用户系统
- 注册 / 登录
- 随机头像分配
- JWT 身份验证
- 密码加密存储（bcrypt）

## 🔧 技术栈

| 技术 | 用途 |
|------|------|
| Express | HTTP 服务器 |
| Socket.IO | 实时通讯（群聊） |
| better-sqlite3 | 轻量数据库 |
| bcryptjs | 密码加密 |
| jsonwebtoken | JWT 身份验证 |

## 📡 API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/register | 注册 |
| POST | /api/login | 登录 |
| GET | /api/me | 获取当前用户 |
| GET | /api/posts | 动态列表 |
| POST | /api/posts | 发布动态 |
| POST | /api/posts/:id/like | 点赞/取消 |
| GET | /api/posts/:id/comments | 评论列表 |
| POST | /api/posts/:id/comments | 发表评论 |
| GET | /api/chat/history | 聊天历史 |

## ⚠️ 注意事项

1. **必须启动后端才能使用社区功能**，其他解压功能不需要后端
2. 数据库文件 `data.db` 存在 `server/` 目录下，删除即清空所有数据
3. 默认端口 3000，可通过环境变量 `PORT` 修改
4. 生产环境请修改 `server.js` 中的 `JWT_SECRET`

## 🌐 局域网访问

想让其他同学也能用？启动后，同一局域网的用户通过你的 IP 访问即可：

```bash
# 查看你的 IP（Mac/Linux）
ifconfig | grep inet

# Windows
ipconfig
```

然后其他人访问 `http://你的IP:3000` 就可以一起用了！
