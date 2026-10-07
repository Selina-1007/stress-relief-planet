/* ============================================================
   解压星球 · 后台推送 Worker（Cloudflare Worker）
   ------------------------------------------------------------
   作用：让「每日心情提醒」在 App 完全关闭时也能推送到手机。
   这是标准 Web Push（VAPID 签名 + RFC8291 aes128gcm 加密），
   全部用 Cloudflare Workers 内置的 WebCrypto 实现。

   环境变量 / 绑定（Cloudflare 控制台里填）：
     1. KV 绑定名  SUB_KV          → 存手机订阅凭证
     2. VAPID_PUBLIC_KEY           → base64url 公钥点（65字节）
     3. VAPID_PRIVATE_JWK          → 私钥 JSON 字符串（含 x/y/d）
   定时触发器：Cron（每天 20:00 等）
   ============================================================ */

export default {
  /* ---------- 1. 订阅 / 退订 / 配置 ---------- */
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    // 探测：是否已配置好推送
    if (request.method === 'GET' && path === '/api/push/config') {
      return new Response(JSON.stringify({
        enabled: !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_JWK && env.SUB_KV),
        publicKey: env.VAPID_PUBLIC_KEY || null,
      }), { headers: { 'Content-Type': 'application/json', ...cors } });
    }

    // 保存订阅（用户开启提醒时网页调用）
    if (request.method === 'POST' && path === '/api/push/subscribe') {
      try {
        const body = await request.json();
        if (!body || !body.endpoint) return new Response(JSON.stringify({ error: '缺少订阅' }), { status: 400, headers: { 'Content-Type': 'application/json', ...cors } });
        await env.SUB_KV.put(body.endpoint, JSON.stringify(body));
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', ...cors } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { 'Content-Type': 'application/json', ...cors } });
      }
    }

    // 取消订阅
    if (request.method === 'POST' && path === '/api/push/unsubscribe') {
      try {
        const body = await request.json();
        if (body && body.endpoint) await env.SUB_KV.delete(body.endpoint);
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', ...cors } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { 'Content-Type': 'application/json', ...cors } });
      }
    }

    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json', ...cors } });
  },

  /* ---------- 2. 定时推送（Cron 每天触发） ---------- */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pushToAll(env, '🌈 今天的心情怎么样？花10秒记录一下吧～'));
  },
};

/* ============================================================
   推送给所有订阅用户
   ============================================================ */
async function pushToAll(env, text) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_JWK || !env.SUB_KV) return 'disabled';
  let cursor;
  do {
    const list = await env.SUB_KV.list({ cursor });
    for (const key of list.keys) {
      const raw = await env.SUB_KV.get(key.name);
      if (!raw) continue;
      try {
        await sendPush(JSON.parse(raw), text, env.VAPID_PRIVATE_JWK);
      } catch (e) {
        // 订阅失效（设备卸载/撤销）→ 删除，避免堆积
        try { await env.SUB_KV.delete(key.name); } catch (e2) {}
      }
    }
    cursor = list.cursor;
  } while (cursor);
  return 'ok';
}

/* ---------- 3. 发送单条推送（VAPID + aes128gcm） ---------- */
async function sendPush(sub, text, privateJwkJson) {
  if (!sub || !sub.endpoint || !sub.keys) return;
  const endpoint = new URL(sub.endpoint);
  const p256dh = b64ToU8(sub.keys.p256dh);
  const auth = b64ToU8(sub.keys.auth);

  // (A) ECDH：服务器临时密钥 ↔ 客户端地址 → 共享密钥
  const serverKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const serverPub = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey));
  const clientPubKey = await importP256(p256dh);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientPubKey }, serverKeys.privateKey, 256
  ));

  // (B) HKDF-SHA256（RFC8291）：deriveKey(ECEK) + deriveKey(nonce)
  const prk = await hmacSha256(auth, sharedSecret);
  const info = new Uint8Array([2, 0, 32, ...p256dh, 8, 0, 65, ...serverPub, 1]);
  const okm = await hmacSha256(prk, info);

  // (C) AES-128-GCM 加密：2 字节 pad 长度 + pad + 文案
  const padLen = 0;
  const data = new TextEncoder().encode(text);
  const record = new Uint8Array(2 + padLen + data.length);
  record[0] = padLen >> 8; record[1] = padLen & 0xff;
  record.set(data, 2 + padLen);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: okm.slice(16, 28), tagLength: 128 },
    okm.slice(0, 16), record
  ));

  // (D) body = salt(16) + serverPub(65) + ciphertext
  const body = new Uint8Array(16 + 65 + ciphertext.length);
  body.set(salt, 0);
  body.set(serverPub, 16);
  body.set(ciphertext, 16 + 65);

  // (E) VAPID JWT（ES256），用现成私钥 JWK 签名
  const now = Math.floor(Date.now() / 1000);
  const signingInput = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
    + '.' + b64url(JSON.stringify({ aud: endpoint.origin, exp: now + 12 * 3600, sub: 'mailto:admin@stress-planet.app' }));
  const sig = await signVapid(signingInput, privateJwkJson);

  const resp = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'TTL': '86400',
      'Content-Encoding': 'aes128gcm',
      'Authorization': 'vapid t=' + signingInput + '.' + sig,
      'Crypto-Key': 'dh=' + b64url(serverPub),
    },
    body,
  });
  if (!resp.ok && resp.status >= 400 && resp.status < 500) {
    throw new Error('push-fail-' + resp.status); // 4xx = 订阅失效
  }
}

/* ---------- Web Crypto 辅助 ---------- */
function importP256(raw) {
  return crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256',
    x: b64url(raw.slice(0, 32)), y: b64url(raw.slice(32, 64)),
    ext: true,
  }, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}

async function signVapid(input, privateJwkJson) {
  const jwk = typeof privateJwkJson === 'string' ? JSON.parse(privateJwkJson) : privateJwkJson;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const der = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input)));
  return derToRawB64(der);
}

function b64url(u8) {
  let bin = '';
  u8.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64ToU8(s) {
  s = (s || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - s.length % 4) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function derToRawB64(der) {
  // ECDSA DER → r(32)||s(32)
  let pos = 5, r = [], s = [];
  if (der[pos] === 0x02) {
    let len = der[pos + 1], start = pos + 2, strip = 0;
    if (der[start] === 0) { strip = 1; }
    r = Array.from(der.slice(start + strip, start + len));
    while (r.length < 32) r.unshift(0);
    if (r.length > 32) r = r.slice(r.length - 32);
    pos = start + len;
  }
  if (der[pos] === 0x02) {
    let len = der[pos + 1], start = pos + 2, strip = 0;
    if (der[start] === 0) { strip = 1; }
    s = Array.from(der.slice(start + strip, start + len));
    while (s.length < 32) s.unshift(0);
    if (s.length > 32) s = s.slice(s.length - 32);
  }
  return b64url(new Uint8Array([...r, ...s]));
}