/* 解压星球 — Service Worker 基础缓存
 * 策略：安装时预缓存核心资源；请求时"先缓存、后台更新"（stale-while-revalidate）
 * 注意：请始终访问 http://localhost:3000 或 https 域名，SW 在 http 非 localhost 下不会注册
 */
const CACHE_NAME = 'stress-planet-v1';
const CORE_ASSETS = [
  './',
  './stress-relief-planet.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

/* ---------- 安装：预缓存核心资源 ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  // 立即激活新 SW，不等旧页面释放
  self.skipWaiting();
});

/* ---------- 激活：清理旧缓存版本 ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  // 让新 SW 立即接管所有受控页面
  self.clients.claim();
});

/* ---------- 收到系统推送 → 弹出通知 ---------- */
self.addEventListener('push', (event) => {
  let title = '🌈 解压星球';
  let body = '今天的心情怎么样？花10秒记录一下吧～';
  try {
    if (event.data) {
      const d = event.data.json();
      if (d.title) title = d.title;
      if (d.body) body = d.body;
    }
  } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: 'moodReminder',
      data: { url: './stress-relief-planet.html' }
    })
  );
});

/* ---------- 点击通知 → 打开应用 ---------- */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './stress-relief-planet.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) { c.navigate(target); return c.focus(); }
      }
      return clients.openWindow(target);
    })
  );
});

/* ---------- 请求拦截：stale-while-revalidate ---------- */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  // 只处理同源 GET 请求，跨域（AI API 等）直接放行，不缓存
  if (request.method !== 'GET' || !request.url.startsWith(self.location.origin)) {
    return;
  }
  // API 请求直接走网络，不做缓存
  if (request.url.includes('/api/')) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      // 拿缓存立即返回，同时后台拉最新版本更新缓存
      const fetchPromise = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached); // 离线时回退到缓存

      return cached || fetchPromise;
    })
  );
});