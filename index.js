// ============================================================
// mx MCP 透传代理（阿里云函数计算 Web 函数 / 本地均可运行，无第三方依赖）
//
// 背景：东方财富「妙想」MCP 上游（mxapi.eastmoney.com/mxds/mcp）直连不稳定：
//   - 版本协商探测超时（客户端仅给 10s）、工具调用 REQUEST_TIMEOUT 高发
//   - 上游偶发 HTTP 500（日志原文 "Server rejected probe; retrying in legacy mode"）
//   - 偶发整次挂载失败（工具数为 0，重连/重启后 11 个工具才恢复）
// 本服务部署在阿里云函数计算上做中转（“从阿里云转”），叠加可靠性机制：
//   1. 上游会话缓存复用，失效自动重新握手（并发去重，避免重复握手）
//   2. 重试矩阵：网络/超时/408/429/5xx 沿用会话退避重试；400/404/会话类
//      RPC 错误重建会话后重试；401/403/业务错误直接返回
//   3. 握手与业务调用分别设置超时：握手 15s 快速失败，把客户端的
//      “legacy 重试”机会留给已建好的热会话；业务调用（自然语言查
//      询较慢）默认放宽到 90s
//   4. SSE 响应自动解析为 JSON-RPC；Accept-Encoding: identity 绕过
//      上游网关透传压缩头导致的“上游响应格式无效”
//   5. tools/list 结果缓存 10 分钟，并剥离 outputSchema（避免客户端强校验）
//   6. initialize 原样透传：客户端请求的协议版本转给上游协商，上游返回的
//      protocolVersion / serverInfo / capabilities 原样回给客户端（与直连一致）；
//      上游不认请求版本时回退默认版本重试；上游未返回身份时兜底代理自身标识
//
// 对客户端：无状态 Streamable HTTP MCP 服务（不下发 mcp-session-id，直接返回 JSON）
// 对上游：  在实例内存中缓存 mx session，闲置 6 分钟过期
// 鉴权（不落盘）：妙想上游真实鉴权头为 em_api_key（源自 CherryStudio
//   「东方财富妙想」服务器配置）。客户端可用任一等价形式携带 Key：
//     em_api_key: <key>（推荐，与直连配置完全一致，只需换 URL）
//     em-api-key / mx-api-key / mx_api_key / x-mx-key: <key>
//     Authorization: Bearer <key>
//   代理统一转成 MX_AUTH_HEADER（默认 em_api_key）发给上游；
//   其余 em-*/mx-* 自定义头原样透传；本服务不保存任何密钥。
//   可选 PROXY_KEY：设置后客户端必须另带 x-proxy-key 同值（防止中转地址被滥用）。
// ============================================================

import http from 'node:http';
import crypto from 'node:crypto';

// ---------------- 配置（环境变量） ----------------
const UPSTREAM = process.env.MX_UPSTREAM || 'https://mxapi.eastmoney.com/mxds/mcp';
const PORT = Number(process.env.FC_SERVER_PORT || process.env.PORT || 9000);
const MX_AUTH_HEADER = process.env.MX_AUTH_HEADER || 'em_api_key';     // 上游要求的鉴权头名
const MX_AUTH_MODE = (process.env.MX_AUTH_MODE || 'raw').toLowerCase(); // raw=自定义头 | bearer=Authorization
const PROXY_KEY = String(process.env.PROXY_KEY || '').trim();           // 可选门禁（x-proxy-key）
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 360_000);   // 上游 session 闲置 6 分钟视为过期
const TOOLS_CACHE_MS = Number(process.env.TOOLS_CACHE_MS || 600_000);   // 工具列表缓存 10 分钟
const HANDSHAKE_TIMEOUT_MS = Number(process.env.HANDSHAKE_TIMEOUT_MS || 15_000); // 握手快速失败
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 90_000);  // 业务调用超时
const BACKOFF_MS = (() => {
  try { return JSON.parse(process.env.BACKOFF_MS || '[0,1000,3000]'); } catch { return [0, 1000, 3000]; }
})(); // 最多 3 次尝试
const DEFAULT_PROTO = '2024-11-05';
const PROXY_VERSION = '1.0.2';   // 代理自身版本（clientInfo 与启动日志用；serverInfo 已透传上游身份）
const MAX_BODY = Number(process.env.MAX_BODY || 1024 * 1024);
const INJECT_HEADERS = (() => {
  try { return JSON.parse(process.env.MX_INJECT_HEADERS || '{}'); } catch { return {}; }
})(); // 可选：静态注入上游头（默认空，保持“密钥不落盘”原则）

// ---------------- 运行期状态 ----------------
const sessions = new Map();   // kh -> { sid, proto, updatedAt }
const inflight = new Map();   // kh -> Promise（防止并发重复握手）
const toolsCache = new Map();  // kh -> { tools, at }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = (p = 'req') => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const hashKey = (k) => crypto.createHash('sha256').update(String(k)).digest('hex').slice(0, 16);

class UpstreamHttpError extends Error {
  constructor(status, body) {
    super(`上游 HTTP ${status}: ${body}`);
    this.status = status;
  }
}

// JSON-RPC 错误分三类：
//   session 失效 → 重建 session 后重试
//   网关临时异常 → 沿用原 session 退避重试
//   其他（业务错误）→ 直接返回，不重试
function isSessionRpcError(err) {
  return /session|会话|not initialized/i.test(err?.message || '');
}
function isTransientRpcError(err) {
  return /上游响应格式无效|timeout|超时|temporarily|unavailable/i.test(err?.message || '');
}

// ---------------- 客户端鉴权头提取与透传 ----------------
// 部分网关会丢弃带下划线的头（如 nginx 默认行为），因此除 em_api_key 外
// 还接受连字符/别名形式；均统一转成上游要求的 MX_AUTH_HEADER。
const KEY_ALIASES = ['em_api_key', 'em-api-key', 'mx-api-key', 'mx_api_key', 'mxapikey', 'x-mx-key'];
const PASSTHROUGH_RE = /^(?:em|mx|x-em|x-mx)[-_]/i; // 其余 em-*/mx-* 自定义头原样透传

function collectAuth(req) {
  let key = '';
  for (const name of KEY_ALIASES) {
    const v = req.headers[name];
    if (typeof v === 'string' && v.trim()) { key = v.trim(); break; }
  }
  if (!key) {
    const auth = String(req.headers['authorization'] || '');
    if (/^Bearer\s+/i.test(auth)) key = auth.replace(/^Bearer\s+/i, '').trim();
  }
  const extra = {};
  for (const name of Object.keys(req.headers)) {
    if (PASSTHROUGH_RE.test(name)) extra[name] = String(req.headers[name]);
  }
  return { key, extra };
}

// 按「Key + 透传头」指纹隔离上游会话：不同 Key 的客户端互不串会话
const fingerprint = (auth) =>
  hashKey(`${auth.key}|${JSON.stringify(Object.keys(auth.extra).sort().map((k) => [k, auth.extra[k]]))}`);

function buildUpstreamHeaders(auth) {
  const h = { ...auth.extra, ...INJECT_HEADERS };
  if (auth.key) {
    if (MX_AUTH_MODE === 'bearer') h['Authorization'] = `Bearer ${auth.key}`;
    else h[MX_AUTH_HEADER] = auth.key;
  }
  return h;
}

// ---------------- 上游通信 ----------------

function parseSse(text) {
  const out = [];
  let buf = [];
  const flush = () => {
    const raw = buf.join('\n').trim();
    buf = [];
    if (raw) { try { out.push(JSON.parse(raw)); } catch {} }
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('data:')) buf.push(line.slice(5).trimStart());
    else if (line.trim() === '' && buf.length) flush();
  }
  if (buf.length) flush();
  return out;
}

async function postUpstream(payload, auth, sid, proto, timeoutMs) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Accept-Encoding': 'identity', // 绕过上游网关透传压缩头导致的“上游响应格式无效”
    ...buildUpstreamHeaders(auth),
  };
  if (sid) headers['mcp-session-id'] = sid;
  if (proto) headers['mcp-protocol-version'] = proto;

  const res = await fetch(UPSTREAM, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs || UPSTREAM_TIMEOUT_MS),
  });
  const newSid = res.headers.get('mcp-session-id') || sid;
  if (res.status === 202 || res.status === 204) return { responses: [], newSid };

  const text = await res.text();
  if (!res.ok) throw new UpstreamHttpError(res.status, text.slice(0, 300));
  if (!text.trim()) return { responses: [], newSid };

  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    return { responses: parseSse(text), newSid };
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('上游响应格式无效'); }
  return { responses: Array.isArray(data) ? data : [data], newSid };
}

async function handshake(auth, kh, requestedProto) {
  // 版本协商透传：优先用客户端请求的版本与上游握手；
  // 上游不认（HTTP 错误或 RPC 错误）时，回退 DEFAULT_PROTO 再试一次
  let ask = requestedProto || DEFAULT_PROTO;
  let proto, newSid, serverInfo, capabilities;

  for (let attempt = 0; attempt < 2; attempt++) {
    const init = {
      jsonrpc: '2.0',
      id: rid('init'),
      method: 'initialize',
      params: {
        protocolVersion: ask,
        capabilities: {},
        clientInfo: { name: 'mx-aliyun-proxy', version: PROXY_VERSION },
      },
    };
    try {
      const res = await postUpstream(init, auth, null, ask, HANDSHAKE_TIMEOUT_MS);
      const r = res.responses.find((m) => m && (m.result !== undefined || m.error !== undefined));
      if (r?.error) throw new Error(`上游 initialize 失败: ${r.error.message || JSON.stringify(r.error)}`);
      proto = r?.result?.protocolVersion || DEFAULT_PROTO;
      serverInfo = r?.result?.serverInfo || null;
      capabilities = r?.result?.capabilities || null;
      newSid = res.newSid;
      break;
    } catch (e) {
      if (attempt === 0 && ask !== DEFAULT_PROTO) { ask = DEFAULT_PROTO; continue; }
      throw e;
    }
  }

  await postUpstream({ jsonrpc: '2.0', method: 'notifications/initialized' }, auth, newSid, proto, HANDSHAKE_TIMEOUT_MS).catch(() => {});

  const st = { sid: newSid, proto, serverInfo, capabilities, updatedAt: Date.now() };
  sessions.set(kh, st);
  console.log(`[session] new kh=${kh} sid=${newSid ? 'yes' : 'none'} proto=${proto} upstream=${serverInfo ? `${serverInfo.name}/${serverInfo.version}` : 'unknown'}`);
  return st;
}

async function ensureSession(auth, kh, force = false, failedSid = null, requestedProto = null) {
  const cur = sessions.get(kh);
  if (cur && !force && Date.now() - cur.updatedAt < SESSION_TTL_MS) return cur;
  // 强制重建时，若别的并发请求已经换了新 session，直接复用
  if (cur && force && failedSid != null && cur.sid !== failedSid) return cur;
  if (inflight.has(kh)) return inflight.get(kh);

  const p = handshake(auth, kh, requestedProto).finally(() => inflight.delete(kh));
  inflight.set(kh, p);
  return p;
}

// 返回上游的 JSON-RPC 响应对象（含 result 或 error）
// 重试策略（尽量少握手）：
//   400 / 404 / session 类 RPC 错误 → 判定 session 失效，重建后重试
//   网络错误 / 超时 / 408 / 429 / 5xx / 网关临时异常 → 沿用原 session 退避重试，不重新握手
//   401 / 403 / 其他 4xx / 业务错误 → 不重试
async function callUpstream(auth, kh, method, params, timeoutMs) {
  const req = { jsonrpc: '2.0', id: rid(), method, params };
  const last = BACKOFF_MS.length - 1;
  let reinit = false;
  let failedSid;
  let lastErr;

  for (let attempt = 0; attempt <= last; attempt++) {
    if (BACKOFF_MS[attempt]) await sleep(BACKOFF_MS[attempt]);
    let st;
    try {
      st = await ensureSession(auth, kh, reinit, failedSid);
      reinit = false; // 本轮 session 已就绪，后续临时错误不再重建
      const { responses } = await postUpstream(req, auth, st.sid, st.proto, timeoutMs);
      const res =
        responses.find((r) => r && r.id === req.id) ||
        responses.find((r) => r && (r.result !== undefined || r.error !== undefined));
      if (!res) throw new Error('上游返回空响应');

      if (res.error && attempt < last) {
        if (isSessionRpcError(res.error)) {
          reinit = true;
          failedSid = st.sid;
          lastErr = new Error(res.error.message);
          continue;
        }
        if (isTransientRpcError(res.error)) {
          lastErr = new Error(res.error.message);
          continue;
        }
      }
      st.updatedAt = Date.now();
      return res;
    } catch (e) {
      lastErr = e;
      if (e instanceof UpstreamHttpError) {
        if (e.status === 400 || e.status === 404) {
          reinit = true;            // 常见于 session 失效
          failedSid = st?.sid;
          continue;
        }
        if (e.status === 408 || e.status === 429 || e.status >= 500) continue; // 临时错误，沿用 session
        throw e;                    // 401 / 403 / 其他 4xx：不重试
      }
      // 网络错误 / 超时 / 响应解析失败：沿用 session 重试
      // （若握手本身失败，sessions 中没有可用 session，下一轮 ensureSession 会自然重新握手）
    }
  }
  throw lastErr;
}

// ---------------- MCP 方法处理 ----------------

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function listTools(auth, kh) {
  const c = toolsCache.get(kh);
  if (c && Date.now() - c.at < TOOLS_CACHE_MS) return c.tools;

  const all = [];
  let cursor;
  do {
    const r = await callUpstream(auth, kh, 'tools/list', cursor ? { cursor } : {}, UPSTREAM_TIMEOUT_MS);
    if (r.error) throw new Error(r.error.message || JSON.stringify(r.error));
    all.push(...(r.result?.tools || []));
    cursor = r.result?.nextCursor;
  } while (cursor && all.length < 5000);

  // 上游给什么工具就原样透传，仅剥离 outputSchema，避免客户端强校验
  const tools = all.map(({ outputSchema, ...t }) => t);
  toolsCache.set(kh, { tools, at: Date.now() });
  return tools;
}

async function handleMessage(msg, auth, kh) {
  const isNotification = msg.id === undefined;
  const { method, params = {} } = msg;

  if (isNotification) return null;
  if (msg.jsonrpc !== '2.0' || typeof method !== 'string') return fail(msg.id ?? null, -32600, 'Invalid Request');

  try {
    switch (method) {
      case 'initialize': {
        // 原样透传：协议版本、serverInfo、capabilities 都以上游协商结果回给客户端（与直连一致）
        const st = await ensureSession(auth, kh, false, null, params.protocolVersion || null); // 顺便验证 Key 与上游连通性
        return ok(msg.id, {
          protocolVersion: st.proto,
          capabilities: st.capabilities || { tools: { listChanged: false } },
          serverInfo: st.serverInfo || { name: 'mx-mcp-aliyun-proxy', version: PROXY_VERSION },
        });
      }

      case 'ping':
        return ok(msg.id, {});

      case 'tools/list':
        return ok(msg.id, { tools: await listTools(auth, kh) });

      case 'tools/call': {
        const name = params.name;
        const t0 = Date.now();
        try {
          const r = await callUpstream(auth, kh, 'tools/call', { name, arguments: params.arguments || {} }, UPSTREAM_TIMEOUT_MS);
          console.log(`[call] ${name} ${Date.now() - t0}ms ${r.error ? 'rpc-error' : 'ok'}`);
          if (r.error) {
            return ok(msg.id, { content: [{ type: 'text', text: `调用妙想失败: ${r.error.message || JSON.stringify(r.error)}` }], isError: true });
          }
          const result = r.result || {};
          return ok(msg.id, {
            ...result,
            content: result.content || [{ type: 'text', text: JSON.stringify(result) }],
            isError: result.isError || false,
          });
        } catch (e) {
          console.log(`[call] ${name} ${Date.now() - t0}ms failed: ${e.message}`);
          return ok(msg.id, { content: [{ type: 'text', text: `调用妙想失败: ${e.message}` }], isError: true });
        }
      }

      default:
        return fail(msg.id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    const authErr = e instanceof UpstreamHttpError && (e.status === 401 || e.status === 403);
    return fail(msg.id, -32603, authErr ? `妙想拒绝了 API Key（HTTP ${e.status}）` : `妙想上游错误: ${e.message}`);
  }
}

// ---------------- HTTP 服务 ----------------

function send(res, status, body) {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

process.on('uncaughtException', (e) => console.error('[uncaught]', e?.message || e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', (e?.message || String(e))));

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) return send(res, 200, 'ok');
  if (pathname !== '/mcp' && pathname !== '/') return send(res, 404, 'not found');
  if (req.method !== 'POST') return send(res, 405, 'method not allowed'); // 无状态服务，不提供 GET SSE 流

  // 可选门禁：PROXY_KEY 设置后，客户端必须带 x-proxy-key 同值
  if (PROXY_KEY && String(req.headers['x-proxy-key'] || '') !== PROXY_KEY) {
    return send(res, 403, { error: 'invalid x-proxy-key' });
  }

  const auth = collectAuth(req);
  if (!auth.key && Object.keys(auth.extra).length === 0 && Object.keys(INJECT_HEADERS).length === 0) {
    return send(res, 401, { error: 'missing mx api key（可用 em_api_key / em-api-key / mx-api-key / Authorization: Bearer <key>）' });
  }
  const kh = fingerprint(auth);

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, fail(null, -32700, 'Parse error'));
  }

  const batch = Array.isArray(payload);
  const msgs = batch ? payload : [payload];
  const replies = (await Promise.all(msgs.map((m) => handleMessage(m || {}, auth, kh)))).filter(Boolean);

  if (replies.length === 0) { res.writeHead(202); return res.end(); }
  return send(res, 200, batch ? replies : replies[0]);
});

server.requestTimeout = 0;      // 业务调用 + 重试可能超过默认 5 分钟
server.headersTimeout = 65_000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`mx MCP proxy v${PROXY_VERSION} listening on :${PORT}  (POST /mcp, upstream=${UPSTREAM}, auth=${MX_AUTH_HEADER}, proto=${DEFAULT_PROTO})`);
});
