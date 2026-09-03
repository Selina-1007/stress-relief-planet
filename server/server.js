const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 密钥：优先读环境变量；未设置时使用开发默认值（生产环境务必通过 JWT_SECRET 注入）
const JWT_SECRET = process.env.JWT_SECRET || 'stress-relief-planet-secret-key-dev-only';

app.use(cors());
app.use(express.json());

// 静态文件 - 提供前端页面
app.use(express.static(path.join(__dirname, '..')));

// 首页直接打开解压星球
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'stress-relief-planet.html'));
});

// JWT 验证中间件
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ code: 401, error: '未登录，请先登录' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    res.status(401).json({ code: 401, error: '登录已过期，请重新登录' });
  }
}

// 健康检查接口（用于前端探测后端是否在线）
app.get('/api/health', (req, res) => {
  res.json({ code: 0, msg: 'ok', server: 'stress-relief-planet' });
});

// ============= AI 投诉 API =============
// 前端把"投诉AI"的意见 POST 到这里。后端不修改源码，而是暂存到内存队列，
// 下一次前端向大模型发请求前，用 GET 把这些投诉取走并拼进 system 提示词的末尾。
const pendingComplaints = []; // {content, at}

app.post('/api/complaints', (req, res) => {
  const { content } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: '投诉内容不能为空' });
  if (content.length > 300) return res.status(400).json({ error: '投诉内容不能超过300字' });
  pendingComplaints.push({ content: content.trim(), at: Date.now() });
  // 防止无限堆积，最多保留最近 20 条
  if (pendingComplaints.length > 20) pendingComplaints.shift();
  res.json({ code: 0, msg: 'ok', count: pendingComplaints.length });
});

// 前端取走待应用的投诉（取完即清空，保证每条只拼进"下一次"的提示词）
app.get('/api/complaints/pending', (req, res) => {
  const items = pendingComplaints.splice(0, pendingComplaints.length);
  res.json({ code: 0, complaints: items.map(i => i.content) });
});

// ============= 用户相关 API =============

// 注册
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请填写用户名和密码' });
  if (username.length < 2) return res.status(400).json({ error: '用户名至少2个字符' });
  if (password.length < 4) return res.status(400).json({ error: '密码至少4位' });

  const exist = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exist) return res.status(400).json({ error: '用户名已被使用' });

  const hashed = bcrypt.hashSync(password, 10);
  const avatars = ['😊', '🌸', '🌙', '⭐', '🍀', '🐱', '🦋', '🌻', '☁️', '🌈'];
  const avatar = avatars[Math.floor(Math.random() * avatars.length)];

  const info = db.prepare('INSERT INTO users (username, password, avatar) VALUES (?, ?, ?)').run(username, hashed, avatar);
  const token = jwt.sign({ id: info.lastInsertRowid, username, avatar }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: info.lastInsertRowid, username, avatar, bio: '还没有签名~' } });
});

// 登录
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(400).json({ error: '用户名或密码错误' });
  }
  const token = jwt.sign({ id: user.id, username: user.username, avatar: user.avatar }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar, bio: user.bio } });
});

// 获取当前用户信息
app.get('/api/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, username, avatar, bio, created_at FROM users WHERE id = ?').get(req.user.id);
  res.json({ user });
});

// 更新个人资料
app.put('/api/profile', authMiddleware, (req, res) => {
  const { avatar, bio } = req.body;
  db.prepare('UPDATE users SET avatar = COALESCE(?, avatar), bio = COALESCE(?, bio) WHERE id = ?').run(avatar, bio, req.user.id);
  const user = db.prepare('SELECT id, username, avatar, bio FROM users WHERE id = ?').get(req.user.id);
  res.json({ user });
});

// ============= 心情广场 API =============

// 获取动态列表
app.get('/api/posts', authMiddleware, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  const posts = db.prepare(`
    SELECT p.*, u.username, u.avatar,
      EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = ?) as liked
    FROM posts p
    JOIN users u ON p.user_id = u.id
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.user.id, limit, offset);

  posts.forEach(p => { p.liked = !!p.liked; });

  const total = db.prepare('SELECT COUNT(*) as count FROM posts').get().count;
  res.json({ posts, total, page, hasMore: offset + posts.length < total });
});

// 发布动态
app.post('/api/posts', authMiddleware, (req, res) => {
  const { content, mood } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: '内容不能为空' });
  if (content.length > 500) return res.status(400).json({ error: '内容不能超过500字' });

  const info = db.prepare('INSERT INTO posts (user_id, content, mood) VALUES (?, ?, ?)').run(req.user.id, content.trim(), mood || '🙂');
  const post = db.prepare(`
    SELECT p.*, u.username, u.avatar, 0 as liked
    FROM posts p JOIN users u ON p.user_id = u.id
    WHERE p.id = ?
  `).get(info.lastInsertRowid);
  post.liked = !!post.liked;

  // 广播新动态
  io.emit('new-post', post);
  res.json({ post });
});

// 点赞 / 取消点赞
app.post('/api/posts/:id/like', authMiddleware, (req, res) => {
  const postId = req.params.id;
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) return res.status(404).json({ error: '动态不存在' });

  const liked = db.prepare('SELECT id FROM likes WHERE user_id = ? AND post_id = ?').get(req.user.id, postId);

  if (liked) {
    db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.user.id, postId);
    db.prepare('UPDATE posts SET likes_count = likes_count - 1 WHERE id = ?').run(postId);
    res.json({ liked: false, likesCount: post.likes_count - 1 });
  } else {
    db.prepare('INSERT INTO likes (user_id, post_id) VALUES (?, ?)').run(req.user.id, postId);
    db.prepare('UPDATE posts SET likes_count = likes_count + 1 WHERE id = ?').run(postId);
    res.json({ liked: true, likesCount: post.likes_count + 1 });
  }
});

// 获取评论
app.get('/api/posts/:id/comments', authMiddleware, (req, res) => {
  const postId = req.params.id;
  const comments = db.prepare(`
    SELECT c.*, u.username, u.avatar
    FROM comments c JOIN users u ON c.user_id = u.id
    WHERE c.post_id = ?
    ORDER BY c.created_at ASC
  `).all(postId);
  res.json({ comments });
});

// 发表评论
app.post('/api/posts/:id/comments', authMiddleware, (req, res) => {
  const postId = req.params.id;
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: '评论内容不能为空' });

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) return res.status(404).json({ error: '动态不存在' });

  const info = db.prepare('INSERT INTO comments (user_id, post_id, content) VALUES (?, ?, ?)').run(req.user.id, postId, content.trim());
  db.prepare('UPDATE posts SET comments_count = comments_count + 1 WHERE id = ?').run(postId);

  const comment = db.prepare(`
    SELECT c.*, u.username, u.avatar
    FROM comments c JOIN users u ON c.user_id = u.id
    WHERE c.id = ?
  `).get(info.lastInsertRowid);

  io.emit('new-comment', { postId, comment });
  res.json({ comment });
});

// ============= 群聊 API =============

// 获取历史消息
app.get('/api/chat/history', authMiddleware, (req, res) => {
  const limit = 50;
  const messages = db.prepare(`
    SELECT m.*, u.username, u.avatar
    FROM chat_messages m JOIN users u ON m.user_id = u.id
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(limit).reverse();
  res.json({ messages });
});

// ============= Socket.IO 实时群聊 =============

const onlineUsers = new Map(); // socketId -> { userId, username, avatar }

io.on('connection', (socket) => {
  console.log('用户连接:', socket.id);

  socket.on('join-chat', (user) => {
    onlineUsers.set(socket.id, user);
    socket.join('chat-room');

    // 通知所有人有新用户加入
    io.to('chat-room').emit('user-joined', {
      user,
      onlineCount: onlineUsers.size,
      system: true
    });

    // 发送在线用户列表
    io.to('chat-room').emit('online-users', Array.from(onlineUsers.values()));
  });

  socket.on('chat-message', (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    // 保存到数据库
    const info = db.prepare('INSERT INTO chat_messages (user_id, content, type) VALUES (?, ?, ?)')
      .run(user.id, data.content, data.type || 'text');

    const message = {
      id: info.lastInsertRowid,
      user_id: user.id,
      username: user.username,
      avatar: user.avatar,
      content: data.content,
      type: data.type || 'text',
      created_at: new Date().toISOString()
    };

    io.to('chat-room').emit('chat-message', message);
  });

  socket.on('disconnect', () => {
    const user = onlineUsers.get(socket.id);
    if (user) {
      onlineUsers.delete(socket.id);
      io.to('chat-room').emit('user-left', {
        user,
        onlineCount: onlineUsers.size,
        system: true
      });
      io.to('chat-room').emit('online-users', Array.from(onlineUsers.values()));
    }
    console.log('用户断开:', socket.id);
  });
});

// ============= 启动服务器 =============

// 404 catch-all —— 对所有未定义的 /api/ 路由返回 JSON（必须放在所有路由之后）
app.use('/api', (req, res) => {
  res.status(404).json({ code: 404, error: `接口不存在: ${req.method} ${req.path}` });
});

// 全局错误处理中间件 —— 确保任何未捕获的异常都返回 JSON 而非纯文本
app.use((err, req, res, next) => {
  console.error('服务器错误:', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ code: 500, error: '服务器内部错误，请稍后重试' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   解压星球 - 后端服务器已启动                  ║
║                                              ║
║   🌐  访问地址: http://localhost:${PORT}          ║
║   🔌  WebSocket: ws://localhost:${PORT}           ║
║   💾  数据库: SQLite (data.db)                ║
╚══════════════════════════════════════════════╝
  `);
});
