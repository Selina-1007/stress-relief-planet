// ===== 解压星球 · DeepSeek 代理 Worker（Cloudflare Workers 免费方案）=====
// 作用：把"智能对话"的请求转发给 DeepSeek。你的 DeepSeek Key 只存在 Worker
//       的机密变量里，绝不出现在任何网页代码中，别人盗不走。
//
// 部署后请在 Cloudflare Worker 的"变量和机密"里添加(机密/Secret)：
//   DEEPSEEK_API_KEY = 你在 platform.deepseek.com 拿到的 sk-xxx（必填）
//   AI_MODEL = deepseek-chat（可选，默认已是）
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS：允许你 GitHub Pages 上的网站跨域调用
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // GET /api/chat/config —— 前端探测这个代理是否可用
    if (request.method === 'GET' && path === '/api/chat/config') {
      return new Response(JSON.stringify({ provider: 'deepseek', enabled: !!env.DEEPSEEK_API_KEY }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // POST /api/chat/gpt —— 转发给 DeepSeek(OpenAI 兼容)
    if (request.method === 'POST' && path === '/api/chat/gpt') {
      if (!env.DEEPSEEK_API_KEY) {
        return new Response(JSON.stringify({ code: 503, error: '未配置 DEEPSEEK_API_KEY', fallback: true }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      let body;
      try { body = await request.json(); }
      catch (e) {
        return new Response(JSON.stringify({ code: 400, error: '请求内容不是合法JSON', fallback: true }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
      const messages = body.messages || [];
      const model = env.AI_MODEL || 'deepseek-chat';

      const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + env.DEEPSEEK_API_KEY,
        },
        body: JSON.stringify({ model, messages, stream: false, max_tokens: 300, temperature: 0.85 }),
      });

      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        return new Response(JSON.stringify({ code: 502, error: 'DeepSeek 上游返回错误', fallback: true, detail: detail.slice(0, 300) }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      const data = await resp.json();
      const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
      if (!content) {
        return new Response(JSON.stringify({ code: 502, error: 'DeepSeek 返回为空', fallback: true }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      return new Response(JSON.stringify({ code: 0, content }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    return new Response(JSON.stringify({ code: 404, error: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  },
};