/**
 * 智能体协作台(host 半)—— 同源代理到 TRD 后端(:8000,默认),前端直接 fetch /agent-hub/* 即可。
 * 后端未就绪时自动探测并拉起内置 backend/(venv+pip+uvicorn),随插件分发、开箱即用。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-agent-hub';
export const inject = ['webServer'];

// TRD 后端地址:默认本机 8000,可用环境变量 TRD_BASE 覆盖
const TRD_BASE = (typeof process !== 'undefined' && process.env && process.env.TRD_BASE) || 'http://127.0.0.1:8000';
let TRD_HOST = '127.0.0.1', TRD_PORT = '8000';
try {
  const u = new URL(TRD_BASE);
  TRD_HOST = u.hostname || '127.0.0.1';
  TRD_PORT = u.port || '8000';
} catch (e) { /* 保持默认 */ }

// 内置后端目录(随插件分发):<包>/backend
const BACKEND_DIR = (() => {
  try { return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'backend'); }
  catch (e) { return path.join(process.cwd(), 'node_modules', 'dsh-agent-hub', 'backend'); }
})();

// 后端自愈状态
const backendState = { status: 'unknown', attempting: false, lastAttempt: 0, pythonFound: null, message: '' };

async function probeBackend() {
  try {
    const r = await fetch(TRD_BASE + '/api/rooms');
    return !!r && r.ok;
  } catch (e) { return false; }
}

async function ensureBackend(ctx) {
  if (backendState.attempting) return;
  if (await probeBackend()) { backendState.status = 'ok'; backendState.attempting = false; return; }
  const sp = ctx.get('subprocess');
  if (!sp) {
    backendState.status = 'no-subprocess';
    backendState.message = '当前 DSH 环境未提供 subprocess 服务,无法自动启动内置后端。';
    return;
  }
  let py = null;
  for (const cand of ['python', 'python3', 'py']) {
    try { py = await sp.resolveExecutable(cand); break; } catch (e) { /* next */ }
  }
  // Windows 下优先改用同目录的 pythonw.exe(GUI 版,永不创建控制台窗口),彻底避免弹出 CMD
  if (py && process.platform === 'win32' && /python(\.exe)?$/i.test(py)) {
    try { py = await sp.resolveExecutable(py.replace(/python(\.exe)?$/i, 'pythonw.exe')); } catch (e) { /* 保持 python */ }
  }
  if (!py) {
    backendState.status = 'no-python';
    backendState.message = '未找到 Python。请安装 Python 3.10+(勾选 Add to PATH)后刷新本页。';
    return;
  }
  if (backendState.lastAttempt && Date.now() - backendState.lastAttempt < 30000) return;
  backendState.lastAttempt = Date.now();
  backendState.attempting = true;
  backendState.pythonFound = py;
  backendState.status = 'starting';
  backendState.message = '正在启动内置 TRD 后端(首次自动创建虚拟环境并安装依赖,约 1-2 分钟)…';
  try {
    const env = Object.assign({}, (typeof process !== 'undefined' && process.env) || {}, {
      TRD_HOST, TRD_PORT, PYTHONUNBUFFERED: '1',
    });
    const handle = sp.spawn({
      argv: [py, path.join(BACKEND_DIR, 'start.py')],
      cwd: BACKEND_DIR,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 2048 }, stderr: { maxBytes: 4096 } },
      graceMs: 5000,
      env,
    });
    handle.done.then(async (res) => {
      backendState.attempting = false;
      // uvicorn 启动有 2-5s 延迟,首次还要建 venv+装依赖(1-2 分钟),重试探测 ~90s 后再判定
      for (let i = 0; i < 60; i++) {
        if (await probeBackend()) { backendState.status = 'ok'; return; }
        await new Promise((r) => setTimeout(r, 1500));
      }
      backendState.status = 'start-failed';
      backendState.message = '内置后端启动失败(进程退出 code=' + String((res && res.code) ?? '?') + ')。可手动运行 backend/start.py 查看原因。';
    }).catch(() => {
      backendState.attempting = false;
      backendState.status = 'start-failed';
      backendState.message = '内置后端进程异常。可手动运行 backend/start.py 查看原因。';
    });
  } catch (e) {
    backendState.status = 'start-failed';
    backendState.message = '启动内置后端出错: ' + String((e && e.message) || e);
    backendState.attempting = false;
  }
}

async function backendHealth() {
  const ok = await probeBackend();
  if (ok) { backendState.status = 'ok'; backendState.attempting = false; return { ok: true }; }
  return { ok: false, status: backendState.status, message: backendState.message, python: backendState.pythonFound };
}

export function apply(ctx) {
  const webServer = ctx.webServer;

  function sendJson(res, code, obj) {
    try {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
    } catch (e) { /* ignore */ }
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let raw = '';
      try {
        req.on('data', (c) => { raw += c; });
        req.on('end', () => resolve(raw));
        req.on('error', () => resolve(raw));
      } catch (e) { resolve(raw); }
    });
  }

  async function proxy(method, pathname, body) {
    try {
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const r = await fetch(TRD_BASE + pathname, {
        method: method || 'GET',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      return { status: r.status, body: text };
    } catch (e) {
      return { status: 502, body: JSON.stringify({ error: 'TRD 服务不可用(' + String((e && e.message) || e) + ')' }) };
    }
  }

  async function proxyJson(res, method, pathname, body) {
    const p = await proxy(method, pathname, body);
    let out;
    try { out = JSON.parse(p.body); } catch (e) { out = { error: p.body }; }
    sendJson(res, p.status, out);
  }

  // 房间列表:GET 列表 | POST 建群
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/agent-hub/rooms', handler: async (req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'POST') {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (e) { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
      return await proxyJson(res, 'POST', '/api/rooms', body);
    }
    await proxyJson(res, 'GET', '/api/rooms');
  }}));
  // 归档房间
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/agent-hub/archived', handler: async (req, res) => {
    await proxyJson(res, 'GET', '/api/archived_rooms');
  }}));
  // 房间:GET 详情(收紧消息体积) | POST 写操作(messages/auto_approve/orchestrator/task)
  ctx.effect(() => webServer.register({ kind: 'prefix', path: '/agent-hub/room', handler: async (req, res) => {
    const url = String(req.url || '').split('?')[0];
    const rest = url.slice('/agent-hub/room/'.length);
    const [id, ...parts] = rest.split('/');
    if (!id) return sendJson(res, 400, { error: '缺少房间 id' });
    const encoded = encodeURIComponent(id);
    const sub = parts.join('/');
    const method = (req.method || 'GET').toUpperCase();

    if (method === 'POST') {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (e) { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
      if (sub === 'messages') return await proxyJson(res, 'POST', '/api/rooms/' + encoded + '/messages', body);
      if (sub === 'auto_approve') return await proxyJson(res, 'POST', '/api/rooms/' + encoded + '/auto_approve', body);
      if (sub === 'orchestrator') return await proxyJson(res, 'POST', '/api/rooms/' + encoded + '/orchestrator', body);
      if (sub === 'task') return await proxyJson(res, 'POST', '/api/rooms/' + encoded + '/task', body);
      if (sub === 'restore') return await proxyJson(res, 'POST', '/api/rooms/' + encoded + '/restore', body);
      if (sub === 'members') return await proxyJson(res, 'POST', '/api/rooms/' + encoded + '/members', body);
      if (sub === 'members/invite_string') return await proxyJson(res, 'POST', '/api/rooms/' + encoded + '/members/invite_string', body);
      return sendJson(res, 404, { error: '未知子路径: ' + sub });
    }
    if (method === 'GET' && sub === '') {
      const p = await proxy('GET', '/api/rooms/' + encoded);
      let data;
      try { data = JSON.parse(p.body); } catch (e) { return sendJson(res, p.status, { error: p.body }); }
      // 只回传最近 60 条,每条内容截断到 2000 字:把几十 MB 级载荷压到百 KB 级
      if (data && Array.isArray(data.messages)) {
        data.messages = data.messages.slice(-60).map((m) => ({ ...m, content: String(m.content || '').slice(0, 2000) }));
      }
      return sendJson(res, p.status, data);
    }
    if (method === 'DELETE' && sub === '') {
      return await proxyJson(res, 'DELETE', '/api/rooms/' + encoded, undefined);
    }
    if (method === 'DELETE' && sub === 'purge') {
      return await proxyJson(res, 'DELETE', '/api/rooms/' + encoded + '/purge', undefined);
    }
    return sendJson(res, 405, { error: '不支持的方法' });
  }}));
  // 任务叫停:POST /agent-hub/tasks/{id}/stop
  ctx.effect(() => webServer.register({ kind: 'prefix', path: '/agent-hub/tasks', handler: async (req, res) => {
    const url = String(req.url || '').split('?')[0];
    const rest = url.slice('/agent-hub/tasks/'.length);
    const [tid, action] = rest.split('/');
    if (!tid || action !== 'stop') return sendJson(res, 400, { error: '用法: /agent-hub/tasks/{id}/stop' });
    if ((req.method || 'GET').toUpperCase() !== 'POST') return sendJson(res, 405, { error: '请用 POST' });
    await proxyJson(res, 'POST', '/api/tasks/' + encodeURIComponent(tid) + '/stop', {});
  }}));
  // 移除成员:DELETE /agent-hub/members/{id}
  ctx.effect(() => webServer.register({ kind: 'prefix', path: '/agent-hub/members', handler: async (req, res) => {
    const url = String(req.url || '').split('?')[0];
    const mid = url.slice('/agent-hub/members/'.length);
    if (!mid) return sendJson(res, 400, { error: '缺少成员 id' });
    if ((req.method || 'GET').toUpperCase() !== 'DELETE') return sendJson(res, 405, { error: '请用 DELETE' });
    await proxyJson(res, 'DELETE', '/api/members/' + encodeURIComponent(mid), undefined);
  }}));
  // 审批:POST /agent-hub/approvals/{id}/approve|reject
  ctx.effect(() => webServer.register({ kind: 'prefix', path: '/agent-hub/approvals', handler: async (req, res) => {
    const url = String(req.url || '').split('?')[0];
    const rest = url.slice('/agent-hub/approvals/'.length);
    const [aid, action] = rest.split('/');
    if (!aid || (action !== 'approve' && action !== 'reject')) {
      return sendJson(res, 400, { error: '用法: /agent-hub/approvals/{id}/approve|reject' });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: '请用 POST' });
    await proxyJson(res, 'POST', '/api/approvals/' + encodeURIComponent(aid) + '/' + action, {});
  }}));
  // 全局章程:GET 读取 / PUT 覆盖(注入大脑与成员的前置规范)
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/agent-hub/charter', handler: async (req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET') return await proxyJson(res, 'GET', '/api/charter');
    if (method === 'PUT') {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (e) { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
      return await proxyJson(res, 'PUT', '/api/charter', body);
    }
    return sendJson(res, 405, { error: '不支持的方法' });
  }}));
  // 后端健康检查(客户端首次安装引导页轮询;?force=1 跳过 30s 节流)
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/agent-hub/health', handler: async (req, res) => {
    if (String(req.url || '').includes('force=1')) backendState.lastAttempt = 0;
    const h = await backendHealth();
    if (!h.ok && !backendState.attempting) ensureBackend(ctx).catch(() => {});
    sendJson(res, 200, h);
  }}));
  // 启动即探测一次(幂等;已有后端则直接复用)
  ensureBackend(ctx).catch(() => {});
}
