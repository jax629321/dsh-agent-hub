/* 任务中继分发器 群聊页逻辑 */
const $ = (id) => document.getElementById(id);
let currentRoom = null;      // 当前房间 id
let currentRoomName = "";    // 当前房间名（生成邀约提示词用）
let members = [];            // 当前房间成员
let orchestratorId = null;   // 当前房间大脑成员 id
let ws = null;
let pendingFiles = [];       // 待发送附件 file_id 列表
let currentApproval = null;  // 待审批记录

const api = async (url, opts = {}) => {
  const r = await fetch(url, opts.method ? {
    ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) }
  } : opts);
  if (!r.ok) { const e = await r.json().catch(() => ({})); alert(e.detail || r.statusText); throw new Error(r.status); }
  return r.json();
};

/* ---------- 房间 ---------- */
async function loadRooms() {
  const rooms = await api("/api/rooms");
  $("room-list").innerHTML = rooms.map(r =>
    `<div class="room-item ${r.id === currentRoom ? "active" : ""}" data-id="${r.id}">
       <span class="room-name">${esc(r.name)}</span>
       <span class="room-del" data-id="${r.id}" title="删除到历史记录">×</span>
     </div>`).join("");
  document.querySelectorAll(".room-item").forEach(el =>
    el.onclick = (e) => {
      if (e.target.classList.contains("room-del")) return;
      openRoom(el.dataset.id);
    });
  document.querySelectorAll(".room-del").forEach(el => el.onclick = async () => {
    const name = el.parentElement.querySelector(".room-name").textContent;
    if (!confirm(`确认删除群「${name}」？\n消息记录会保留到「历史记录」页，可随时恢复。`)) return;
    await api(`/api/rooms/${el.dataset.id}`, { method: "DELETE" });
    if (currentRoom === el.dataset.id) {
      currentRoom = null;
      localStorage.removeItem("trd_last_room");
      location.reload();
      return;
    }
    loadRooms();
  });
}

$("btn-create-room").onclick = async () => {
  const name = $("new-room-name").value.trim();
  if (!name) return;
  $("new-room-name").value = "";
  const room = await api("/api/rooms", { method: "POST", body: JSON.stringify({ name }) });
  await loadRooms();
  openRoom(room.id);
};

async function openRoom(roomId) {
  currentRoom = roomId;
  localStorage.setItem("trd_last_room", roomId);
  const d = await api(`/api/rooms/${roomId}`);
  $("room-title").textContent = d.room.name;
  currentRoomName = d.room.name;
  $("auto-approve-wrap").hidden = false;
  $("auto-approve").checked = !!d.room.auto_approve;
  $("btn-stop").hidden = !d.running_task;
  members = d.members;
  orchestratorId = d.room.orchestrator_member_id || null;
  renderMembers();
  $("memory-box").hidden = false;
  $("memory-text").value = d.room.memory || "";
  renderMessages(d.messages, true);
  currentApproval = d.pending_approvals[0] || null;
  renderApproval();
  loadRooms();
  connectWs();
}

/* ---------- WebSocket ---------- */
function connectWs() {
  if (ws) ws.close();
  ws = new WebSocket(`ws://${location.host}/ws/${currentRoom}`);
  ws.onopen = async () => {
    // （重）连后全量同步一次，补回断连期间漏收的消息
    if (!currentRoom) return;
    const d = await api(`/api/rooms/${currentRoom}`);
    if (!currentRoom || d.room.id !== currentRoom) return;
    renderMessages(d.messages);
    currentApproval = d.pending_approvals[0] || null;
    renderApproval();
    $("btn-stop").hidden = !d.running_task;
  };
  ws.onmessage = (ev) => {
    const p = JSON.parse(ev.data);
    console.log("[ws]", p.kind, (p.message || {}).status || "");
    if (p.kind === "message") {
      appendMessage(p.message, p.replace_id);
      // 任务终态系统消息到达时，同步叫停按钮与审批条
      if (p.message.sender_type === "system" &&
          /任务完成|熔断|任务停止|否决|终止|叫停/.test(p.message.content || "")) {
        $("btn-stop").hidden = true;
        currentApproval = null; renderApproval();
      }
      syncMemory();
    }
    if (p.kind === "approval") { currentApproval = p.approval; renderApproval(); syncMemory(); }
  };
  ws.onclose = () => setTimeout(() => currentRoom && connectWs(), 2000);
}

/* 看门狗：连接中断（含半开）时强制重连 */
setInterval(() => {
  if (currentRoom && (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED))
    connectWs();
}, 3000);

/* ---------- 消息渲染 ---------- */
/* “有新消息”提示条：用户上翻查看历史时，新消息不再强制拉扯滚动，
   仅显示提示条，点击后跳到底部。元素由 JS 动态挂载到 #messages 容器。 */
let _newMsgTip = null;
function ensureNewMsgTip() {
  if (_newMsgTip) return _newMsgTip;
  const box = $("messages");
  _newMsgTip = document.createElement("div");
  _newMsgTip.className = "new-msg-tip";
  _newMsgTip.textContent = "↓ 有新消息";
  _newMsgTip.style.display = "none";
  _newMsgTip.onclick = () => {
    box.scrollTop = box.scrollHeight;
    hideNewMsgTip();
  };
  box.parentElement.appendChild(_newMsgTip);
  // 用户自己滚回底部时自动隐藏提示条
  box.addEventListener("scroll", () => {
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 120) hideNewMsgTip();
  });
  return _newMsgTip;
}
function showNewMsgTip() { const t = ensureNewMsgTip(); t.style.display = "block"; }
function hideNewMsgTip() { if (_newMsgTip) _newMsgTip.style.display = "none"; }

function renderMessages(list, scrollToBottom = true) {
  $("messages").innerHTML = "";
  list.forEach(m => appendMessage(m));
  if (scrollToBottom) { $("messages").scrollTop = $("messages").scrollHeight; hideNewMsgTip(); }
}
function appendMessage(m, replaceId) {
  if (replaceId) { const old = $(`msg-${replaceId}`); if (old) old.remove(); }
  if ($(`msg-${m.id}`)) return;
  const div = document.createElement("div");
  div.className = `msg ${m.sender_type} ${m.status !== "done" ? m.status : ""}`;
  div.id = `msg-${m.id}`;
  let files = "";
  try {
    const ids = JSON.parse(m.file_ids || "[]");
    if (ids.length) files = `<div class="files">` + ids.map(id =>
      `<a href="/api/files/${id}" target="_blank">附件</a>`).join(" ") + `</div>`;
  } catch (e) {}
  div.innerHTML = `<div class="meta">${esc(m.sender_name)} · ${new Date(m.created_at * 1000).toLocaleTimeString()}</div>
    <div class="bubble">${esc(m.content || "")}</div>${files}`;
  const box = $("messages");
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.appendChild(div);
  if (nearBottom) box.scrollTop = box.scrollHeight;
  else showNewMsgTip();
}

/* ---------- 发送与 @ ---------- */
$("btn-send").onclick = send;
$("input").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && $("mention-popup").hidden) { e.preventDefault(); send(); }
});
async function send() {
  const content = $("input").value.trim();
  if (!content || !currentRoom) return;
  $("input").value = "";
  const file_ids = pendingFiles; pendingFiles = []; renderAttach();
  await api(`/api/rooms/${currentRoom}/messages`, { method: "POST",
    body: JSON.stringify({ content, file_ids }) });
}

$("btn-brain").onclick = async () => {
  const requirement = $("input").value.trim();
  if (!requirement || !currentRoom) return;
  $("input").value = "";
  await api(`/api/rooms/${currentRoom}/task`, { method: "POST", body: JSON.stringify({ requirement }) });
  $("btn-stop").hidden = false;
};

$("btn-stop").onclick = async () => {
  const d = await api(`/api/rooms/${currentRoom}`);
  if (d.running_task) await api(`/api/tasks/${d.running_task.id}/stop`, { method: "POST", body: "{}" });
  $("btn-stop").hidden = true;
};

/* @ 自动补全 */
$("input").addEventListener("input", () => {
  const v = $("input").value, m = v.match(/@([\w一-龥]*)$/);
  if (!m) { $("mention-popup").hidden = true; return; }
  const kw = m[1];
  const hits = members.filter(x => x.name.includes(kw));
  if (!hits.length) { $("mention-popup").hidden = true; return; }
  $("mention-popup").innerHTML = hits.map(x =>
    `<div class="mention-item" data-name="${esc(x.name)}">@${esc(x.name)}</div>`).join("");
  $("mention-popup").hidden = false;
  document.querySelectorAll(".mention-item").forEach(el => el.onclick = () => {
    $("input").value = v.replace(/@[\w一-龥]*$/, "@" + el.dataset.name + " ");
    $("mention-popup").hidden = true; $("input").focus();
  });
});

/* ---------- 附件 ---------- */
$("btn-attach").onclick = () => $("file-input").click();
$("file-input").onchange = async () => {
  for (const f of $("file-input").files) {
    const fd = new FormData(); fd.append("file", f);
    const r = await fetch(`/api/rooms/${currentRoom}/files`, { method: "POST", body: fd });
    const rec = await r.json();
    pendingFiles.push(rec.id); rec._name = f.name;
    pendingFiles[pendingFiles.length - 1] = rec.id;
    renderAttach(rec.id, f.name);
  }
  $("file-input").value = "";
};
const attachNames = {};
function renderAttach(id, name) {
  if (id) attachNames[id] = name;
  $("attach-list").innerHTML = pendingFiles.map(i => `<span>📎 ${esc(attachNames[i] || i)}</span>`).join("");
}

/* ---------- 审批 ---------- */
function renderApproval() {
  if (!currentApproval) { $("approval-bar").hidden = true; return; }
  const plan = JSON.parse(currentApproval.plan_json);
  const lines = [`【第 ${currentApproval.round} 轮计划】${plan.plan || ""}`, ""]
    .concat((plan.dispatch || []).map(d => `→ @${d.member}：${d.task}`));
  $("approval-text").textContent = lines.join("\n");
  $("approval-bar").hidden = false;
}
$("btn-approve").onclick = async () => {
  await api(`/api/approvals/${currentApproval.id}/approve`, { method: "POST", body: "{}" });
  currentApproval = null; renderApproval();
};
$("btn-reject").onclick = async () => {
  await api(`/api/approvals/${currentApproval.id}/reject`, { method: "POST", body: "{}" });
  currentApproval = null; renderApproval();
};

/* ---------- 群记忆 ---------- */
async function syncMemory() {
  // 大脑每轮沉淀记忆后实时同步到侧栏；用户正在编辑时不覆盖
  if (!currentRoom || document.activeElement === $("memory-text")) return;
  const d = await api(`/api/rooms/${currentRoom}`);
  if (currentRoom === d.room.id) $("memory-text").value = d.room.memory || "";
}

$("btn-save-memory").onclick = async () => {
  await api(`/api/rooms/${currentRoom}/memory`, { method: "PUT",
    body: JSON.stringify({ memory: $("memory-text").value }) });
  $("btn-save-memory").textContent = "已保存";
  setTimeout(() => $("btn-save-memory").textContent = "保存记忆", 1200);
};

/* ---------- 自动批准开关 ---------- */
$("auto-approve").onchange = async () => {
  await api(`/api/rooms/${currentRoom}/auto_approve`, { method: "POST",
    body: JSON.stringify({ flag: $("auto-approve").checked }) });
};

/* ---------- 成员 ---------- */
/* 生成中继成员的一键邀约提示词：内嵌成员名/群名/token 端点/工具配置指令/工作循环
   双模式：Webhook 推模式（推荐，免轮询不阻塞）+ 轮询兜底（无回调能力时）。 */
function buildBridgePrompt(m) {
  const base = location.origin;
  const poll = `${base}/api/bridge/${m.invite_token}/poll`;
  const submit = `${base}/api/bridge/${m.invite_token}/submit`;
  const heartbeat = `${base}/api/bridge/${m.invite_token}/heartbeat`;
  const callback = `${base}/api/bridge/${m.invite_token}/callback`;
  const toolIntro = {
    relay: "",
    workbuddy: `# 工具身份:你是运行在 WorkBuddy(腾讯)里的 Agent。
WorkBuddy 能力提示:你拥有文件读写、命令执行、Skills 技能、MCP 工具与联网搜索。
接到任务后请像独立员工一样直接动手:产出代码/报告/文件,把最终成果全文(重要产物附文件路径)放入 submit_result 的 content,不要只回复"收到"。
`,
    trae: `# 工具身份:你是运行在 Trae Work(IDE)里的 Agent。
Trae 能力提示:你拥有工程文件读写、终端命令、代码搜索与联网能力。
开发/文件类任务请直接动手产出并提交完整成果;请把轮询循环当作常驻后台任务持续运行,任务间隙休息 10~30 秒后继续取任务,不要主动停止。
`,
  }[m.type] || "";
  const mode0 = ["workbuddy", "trae", "relay"].includes(m.type) ? `# 工作模式 0：运行中继 Worker 脚本（推荐，免轮询、可常驻）
对话式 Agent 在回合结束后无法自己继续轮询，请用常驻进程承担传输：
1. 在本地运行中继 Worker（脚本已内置在 E:\\AI项目区域\\AI会议室\\worker\\trd-worker.js）：
   node E:\\AI项目区域\\AI会议室\\worker\\trd-worker.js ${m.invite_token}
2. 该进程会注册 Webhook 自动接收群内新任务（写入 worker\\trd-worker\\inbox\\），
   并在 outbox 出现回复文件时自动提交回群聊，同时持续心跳保活。
3. 你的职责：发现 inbox 出现新任务文件 → 执行任务 → 把完整交付写入对应的 outbox 文件。
   若你无法自行启动后台进程，请原样转告你的操作者运行上述命令。
` : "";
  const modeM = ["workbuddy", "trae", "relay"].includes(m.type) ? `# 工作模式 M：通过 MCP 接入（推荐，任何支持 MCP 的工具通用）
如果你（所在工具）支持 MCP（Model Context Protocol）客户端，请用统一接入方式，与 WorkBuddy/Trae/ZCode/Cline/Claude Code 完全一致：
1. 在工具设置里新增一个 MCP 服务器（stdio 类型）：
   命令：node
   参数：E:\\AI项目区域\\AI会议室\\mcp\\trd-mcp.js --dir E:\\AI项目区域\\AI会议室\\worker\\trd-worker
2. 接入后按以下循环工作（不用自己轮询，传输由 Worker 进程负责）：
   - 每轮开始先调用 trd_inbox 查看群内是否有待处理任务；
   - 有任务 → trd_read_task 读取全文 → 用你的全部能力执行 → trd_reply 提交完整交付内容；
   - 重复此循环。
3. 若你无法配置 MCP，可让操作者代为配置，或使用工作模式 0 的 Worker + inbox/outbox 文件。
` : "";
  return `你是「任务中继分发器」多Agent协作群的成员，通过 Bridge 接口与群全自动交互。
${toolIntro}
${mode0}
${modeM}
# 你的身份（已固定，勿改名）
- 成员名：${m.name}
- 所属群聊：${currentRoomName}
- 本提示词中的接口地址专属于你在该群的身份，每个群、每个成员各不同，请勿混用。

# 第一步：配置 HTTP 工具
如果你的平台支持通过提示词自主创建工具，请立即自行创建以下工具；
如果不能自主创建，请原样转告你的操作者完成配置，然后告诉我"工具已就绪"：
1. 工具名 register_callback（注册推送地址，推模式必用）
   方法 POST，地址：${callback}
   请求头 Content-Type: application/json
   请求体 {"callback_url": "<你的 Webhook 接收地址>"}
2. 工具名 submit_result（交结果）
   方法 POST，地址：${submit}
   请求头 Content-Type: application/json
   请求体 {"content": "<你的任务结果全文>", "reply_token": "<任务附带的 reply_token>"}
3. 工具名 heartbeat（保活，长任务时必用）
   方法 POST，地址：${heartbeat}
   无请求体。执行耗时较长的任务时，每 2 分钟调用一次，防止任务被误判僵死。
4. 工具名 poll_task（取任务，轮询兜底用）
   方法 GET，地址：${poll}
   无请求参数。返回 {"waiting": 是否有任务, "task": "任务文本或null", "reply_token": "提交时必带的令牌"}

# 工作模式 A：Webhook 推模式（推荐，首选）
如果你的平台支持对外暴露一个 HTTP POST 接收端点（Webhook），请优先使用本模式：
1. 准备好你的 Webhook 接收地址，调用 register_callback 完成注册。
   注册成功后，服务端会在每次有新任务时主动向该地址 POST 如下 JSON：
   {"event": "task.new", "task": "任务全文（含群聊上下文与你的指令）",
    "reply_token": "提交时必带的令牌", "token": "你的身份 token",
    "submit_path": "/api/bridge/<token>/submit", "heartbeat_path": "/api/bridge/<token>/heartbeat"}
2. 收到 task.new 推送后：保存 reply_token → 认真执行任务 → 调用 submit_result 提交完整成果。
   桥接服务源地址为 ${base}，推送中的 *_path 需拼接该源地址使用。
3. 若收到 {"event": "task.cancelled"} 推送：任务已被叫停，停止执行并丢弃保存的 reply_token。
本模式优势：无需轮询等待，不会阻塞你的会话，没有执行时长限制；
任务间隙你可以自由处理其他事情，真正像 API 一样异步工作。

# 工作模式 B：轮询兜底（无 Webhook 能力时使用）
1. 调用 poll_task。
2. 若 waiting=false：暂无任务，等待 10~30 秒后重新调用 poll_task。
3. 若 waiting=true：task 内容分两段——【群聊最近记录】供你了解上下文，
   【现在交给你的任务】是你本轮必须完成的指令。同时务必保存 reply_token，提交时必须携带。
4. 认真完成任务后，立即调用 submit_result，把完整成果放入 content，并携带保存的 reply_token。
5. 提交后回到第 1 步，继续轮询下一个任务。

# 重要：reply_token 机制
- 每个新任务都有唯一的 reply_token（推送或 poll 返回），它是该任务的身份证。
- submit_result 必须携带同一个 reply_token，否则会被拒绝（防止串任务、防重复提交）。
- 如果提交返回 token_mismatch 错误，说明任务已过期或被替换，请重新 poll 获取最新任务。

# 长任务保活
- 若任务预计执行超过 5 分钟，每 2 分钟调用一次 heartbeat，否则任务可能被判定僵死清理。
- 提交完成后无需再调 heartbeat。

# 纪律
- 每个任务必须提交一次且仅一次结果，不要重复提交。
- 结果要直接、完整、可交付；不要提交"收到"这类无内容回复。
- 若任务超出能力，在 content 中如实说明原因和建议，也算有效交付。
- 你在群里的显示名就是「${m.name}」，回复不必再署名。`;
}

function renderMembers() {
  $("member-list").innerHTML = members.map(m => {
    const typeName = { openai: "API", coze: "扣子", dsh: "DSH", workbuddy: "WB", trae: "Trae", relay: "中继" }[m.type] || m.type;
    const isBrain = m.id === orchestratorId;
    const brainTag = isBrain ? `<span class="tag brain">大脑</span>` : "";
    const isBridgeType = ["relay", "trae", "workbuddy"].includes(m.type);
    const cbTag = isBridgeType
      ? `<span class="tag ${m.callback_url ? "cb-on" : "cb-off"}" title="${m.callback_url ? "Webhook: " + esc(m.callback_url) : "未注册 Webhook，走轮询"}">${m.callback_url ? "推送" : "轮询"}</span>` : "";
    const dshTag = m.type === "dsh"
      ? `<span class="tag cb-on" title="DSH 桥: ${esc(m.dsh_base_url || "http://127.0.0.1:3080")}">桥</span>` : "";
    const brainBtn = `<span class="brain-btn" data-id="${m.id}" data-on="${isBrain ? 1 : 0}">${isBrain ? "取消大脑" : "设为大脑"}</span>`;
    const link = isBridgeType && m.invite_token
      ? `<span class="relay-link">${m.type === "relay" ? "邀约链接" : "接入链接"}: ${location.origin}/relay.html?token=${m.invite_token}</span>
         <details class="prompt-box">
           <summary>📋 一键邀约提示词（发给 Agent 即完成接入）</summary>
           <pre class="prompt-text">${esc(buildBridgePrompt(m))}</pre>
           <button class="prompt-copy">复制提示词</button>
         </details>` : "";
    return `<div class="member-item">${esc(m.name)}<span class="tag">${typeName}</span>${brainTag}${cbTag}${dshTag}
      <span class="del" data-id="${m.id}">移除</span>${brainBtn}${link}</div>`;
  }).join("");
  document.querySelectorAll(".member-item .del").forEach(el => el.onclick = async () => {
    if (!confirm("确认移除该成员？")) return;
    await api(`/api/members/${el.dataset.id}`, { method: "DELETE", body: "{}" });
    openRoom(currentRoom);
  });
  document.querySelectorAll(".prompt-copy").forEach(el => el.onclick = () => {
    const text = el.parentElement.querySelector(".prompt-text").textContent;
    navigator.clipboard.writeText(text).then(() => {
      el.textContent = "已复制 ✓";
      setTimeout(() => el.textContent = "复制提示词", 1500);
    });
  });
  document.querySelectorAll(".member-item .brain-btn").forEach(el => el.onclick = async () => {
    const member_id = el.dataset.on === "1" ? null : el.dataset.id;
    await api(`/api/rooms/${currentRoom}/orchestrator`, { method: "POST",
      body: JSON.stringify({ member_id }) });
    openRoom(currentRoom);
  });
}

$("m-type").onchange = () => {
  $("f-openai").hidden = $("m-type").value !== "openai";
  $("f-coze").hidden = $("m-type").value !== "coze";
  $("f-dsh").hidden = $("m-type").value !== "dsh";
};

$("btn-add-member").onclick = async () => {
  const body = { name: $("m-name").value, type: $("m-type").value,
    base_url: $("m-base-url").value, api_key: $("m-api-key").value, model: $("m-model").value,
    pat_token: $("m-pat").value, bot_id: $("m-bot-id").value,
    dsh_base_url: $("m-dsh-base-url").value, dsh_token: $("m-dsh-token").value };
  await api(`/api/rooms/${currentRoom}/members`, { method: "POST", body: JSON.stringify(body) });
  ["m-name", "m-base-url", "m-api-key", "m-model", "m-pat", "m-bot-id", "m-dsh-base-url", "m-dsh-token"].forEach(i => $(i).value = "");
  openRoom(currentRoom);
};

$("btn-invite-string").onclick = async () => {
  const invite = $("invite-string").value.trim();
  if (!invite) return;
  await api(`/api/rooms/${currentRoom}/members/invite_string`, { method: "POST",
    body: JSON.stringify({ invite }) });
  $("invite-string").value = "";
  openRoom(currentRoom);
};

/* ---------- 工具 ---------- */
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

loadRooms().then(() => {
  const last = localStorage.getItem("trd_last_room");
  if (last && document.querySelector(`.room-item[data-id="${last}"]`)) openRoom(last);
});

/* ---------- 主题切换 ---------- */
(function() {
  const btn = $("btn-theme");
  const html = document.documentElement;
  const update = (t) => {
    html.setAttribute("data-theme", t);
    btn.textContent = t === "light" ? "☀️" : "🌙";
    btn.title = t === "light" ? "切换到深色主题" : "切换到浅色主题";
    localStorage.setItem("trd_theme", t);
  };
  btn.onclick = () => update(html.getAttribute("data-theme") === "light" ? "dark" : "light");
  // 恢复上次主题
  const saved = localStorage.getItem("trd_theme") || "dark";
  update(saved);
})();

/* ---------- 面板拖拽 resize ---------- */
(function() {
  const resizers = document.querySelectorAll(".resizer");
  let raf = null;
  resizers.forEach(r => {
    r.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const panel = document.getElementById(r.dataset.panel);
      if (!panel) return;
      const isRight = panel.id === "members-panel";
      const startX = e.clientX;
      const startW = panel.offsetWidth;
      r.classList.add("active");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev) => {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const delta = isRight ? startX - ev.clientX : ev.clientX - startX;
          const w = Math.max(panel.dataset.min || 160, Math.min(startW + delta, panel.dataset.max || 460));
          panel.style.width = w + "px";
          panel.style.flex = "none";
          panel.dataset._w = w;
        });
      };
      const onUp = () => {
        r.classList.remove("active");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        const w = panel.dataset._w || panel.offsetWidth;
        localStorage.setItem("trd_panel_" + panel.id, w);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
  // 恢复上次保存的宽度
  ["rooms", "members-panel"].forEach(id => {
    const saved = localStorage.getItem("trd_panel_" + id);
    const p = document.getElementById(id);
    if (saved && p) {
      p.style.width = saved + "px";
      p.style.flex = "none";
    }
  });
})();
