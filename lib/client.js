window.__ModuleLoader__.load({
	id: "dsh-agent-hub",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");

		// ---- 模块级外部 store(useSyncExternalStore 正规订阅,重渲染可靠) ----
		var store = { open: false, rooms: [], archived: [], activeId: null, detail: null, backend: null, showArchived: false };
		var version = 0;
		var listeners = new Set();
		function subscribe(fn) { listeners.add(fn); return function () { listeners.delete(fn); }; }
		function getSnapshot() { return version; }
		function emit() { version++; listeners.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } }); }
		function useStore() {
			react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
			return store;
		}
		function setOpen(v) { store.open = v; emit(); }
		function setActive(id) { store.activeId = id; store.detail = null; emit(); }

		async function loadRooms() {
			try { store.rooms = await (await fetch("/agent-hub/rooms")).json(); } catch (e) { /* ignore */ }
			emit();
		}
		async function loadDetail(id) {
			if (!id) return;
			try {
				var r = await fetch("/agent-hub/room/" + id);
				store.detail = await r.json();
			} catch (e) { store.detail = { error: String((e && e.message) || e) }; }
			emit();
		}

		// ---- 动作(写操作,完成后刷新详情) ----
		function postJson(url, body) {
			return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body === undefined ? {} : body) }).then(function (r) { return r.json(); });
		}
		function delJson(url) {
			return fetch(url, { method: "DELETE" }).then(function (r) { return r.json(); });
		}
		function refresh() { if (store.activeId) loadDetail(store.activeId); }
		function sendMessage(content) { return postJson("/agent-hub/room/" + store.activeId + "/messages", { content: content, file_ids: [] }); }
		function sendToBrain(requirement) { return postJson("/agent-hub/room/" + store.activeId + "/task", { requirement: requirement }); }
		function stopTask(tid) { return postJson("/agent-hub/tasks/" + tid + "/stop", {}); }
		function setAutoApprove(flag) { return postJson("/agent-hub/room/" + store.activeId + "/auto_approve", { flag: flag }); }
		function setOrchestrator(memberId) { return postJson("/agent-hub/room/" + store.activeId + "/orchestrator", { member_id: memberId }); }
		function removeMember(mid) { return delJson("/agent-hub/members/" + mid); }
		var TYPE_NAMES = { openai: "API", coze: "扣子", dsh: "DSH", workbuddy: "WB", trae: "Trae", relay: "中继" };

		function loadArchived() {
			fetch("/agent-hub/archived").then(function (r) { return r.json(); }).then(function (list) {
				store.archived = Array.isArray(list) ? list : [];
				emit();
			}).catch(function () {});
		}
		function createRoomNamed(name) {
			var v = (name || "").trim();
			if (!v) return Promise.resolve(null);
			return postJson("/agent-hub/rooms", { name: v, auto_approve: false }).then(function (room) {
				loadRooms();
				if (room && room.id) { store.showArchived = false; setActive(room.id); }
				return room;
			}).catch(function () { return null; });
		}
		// 无群时的默认使用指引(DSH 专属 + 具体流程)
		var WELCOME_TEXT =
			"成员 = 接入的 Agent。推荐流程:\n\n" +
			"1️⃣ 接入成员:\n" +
			"   · DSH Agent:在任意 DSH 会话调用 trd_connect(roomName=本群名)接入(成员名=你填的显示名);\n" +
			"   · OpenAI 兼容 API:右侧成员栏「邀请成员」→ 类型选 OpenAI 兼容 → 填 base_url / api_key / model。\n\n" +
			"2️⃣ 设大脑:把某成员点「设为大脑」——负责拆解需求、分工、监督、逐轮验收。\n" +
			"3️⃣ 派发:@成员名 + 发送=定向派单;「发给大脑」=交给大脑自主拆解推进;勾选「自动批准持续任务」=大脑每轮无需人工确认,持续推进。\n" +
			"4️⃣ 验收:大脑逐轮核对交付,通过后写入群记忆;可随时「叫停」或逐轮「确认/否决」。\n\n" +
			"现在,给第一个群起个名字吧 👇";

		// ---- DSH 主题 token(跟随 dsh 设置配色,深浅自动切换;带回退色) ----
		var T = {
			bgBase: "var(--dsw-alias-bg-base, #11151b)",
			layer1: "var(--dsw-alias-bg-layer-1, #1a1f27)",
			layer2: "var(--dsw-alias-bg-layer-2, #161a20)",
			overlay: "var(--dsw-alias-bg-overlay, #0f1216)",
			border1: "var(--dsw-alias-border-l1, #2a303a)",
			border2: "var(--dsw-alias-border-l2, #3a4250)",
			brand: "var(--dsw-alias-brand-primary, #4f8cff)",
			label1: "var(--dsw-alias-label-primary, #d6d9de)",
			label2: "var(--dsw-alias-label-secondary, #8b96a5)",
			err: "var(--dsw-alias-state-error-primary, #ff7b72)",
			ok: "var(--dsw-alias-state-success-primary, #7ee787)",
			warn: "var(--dsw-alias-state-warn-primary, #d29922)",
		};
		function tint(color, pct) { return "color-mix(in srgb, " + color + " " + pct + ", transparent)"; }

		var SIDEBAR_W = 236; // DSH 左侧边栏宽度(px):若你的 DSH 布局边栏宽度不同,改这一处即可

		// ---- 样式(全部引用主题 token) ----
		var C = {
			overlay: { position: "fixed", left: SIDEBAR_W, top: 0, bottom: 0, right: 0, zIndex: 9000, display: "flex", background: T.bgBase, color: T.label1, fontFamily: "Segoe UI, system-ui, sans-serif", fontSize: 13, boxShadow: "0 0 40px rgba(0,0,0,.35)", pointerEvents: "auto" },
			drawer: { width: 196, background: T.layer1, borderRight: "1px solid " + T.border1, display: "flex", flexDirection: "column", flexShrink: 0 },
			chat: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0 },
			members: { width: 252, background: T.layer2, borderLeft: "1px solid " + T.border1, overflow: "auto", flexShrink: 0 },
		};
		var BTN = { background: T.layer1, border: "1px solid " + T.border2, color: T.label1, borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12 };
		var PALETTE = ["#6fb3ff", "#7ee787", "#f0a868", "#b48cff", "#ff7b72", "#56d4dd", "#ff9ecf"];
		function colorOf(name) {
			var h = 0, s = String(name || "");
			for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
			return PALETTE[h % PALETTE.length];
		}
		function fmtTime(ts) {
			if (!ts) return "";
			var d = new Date(Number(ts) * 1000);
			var p = function (n) { return (n < 10 ? "0" : "") + n; };
			return p(d.getHours()) + ":" + p(d.getMinutes());
		}

		// ---- 房间抽屉 ----
		function Drawer(props) {
			var s = props.s;
			var nameState = react.useState("");
			var newName = nameState[0], setNewName = nameState[1];
			function createRoom() { createRoomNamed(newName).then(function () { setNewName(""); }); }

			if (s.showArchived) {
				var arch = [];
				for (var i = 0; i < s.archived.length; i++) {
					(function (r) {
						arch.push(react.createElement("div", { key: r.id, style: { padding: "8px 10px", borderBottom: "1px solid " + T.border1 } },
							react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, color: T.label1, fontSize: 12, marginBottom: 4 } },
								react.createElement("span", { style: { flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, r.name),
								react.createElement("span", { style: { color: T.label2, fontSize: 10, flexShrink: 0 } }, "成员 " + (r.member_count || 0) + " · 消息 " + (r.message_count || 0))),
							react.createElement("div", { style: { display: "flex", gap: 8, paddingLeft: 2 } },
								react.createElement("span", { onClick: function () { postJson("/agent-hub/room/" + r.id + "/restore", {}).then(function () { loadArchived(); loadRooms(); }); }, style: { fontSize: 11, cursor: "pointer", color: T.ok } }, "恢复"),
								react.createElement("span", { onClick: function () { if (window.confirm("彻底删除群「" + r.name + "」?将清除全部消息与成员,不可恢复!")) { delJson("/agent-hub/room/" + r.id + "/purge").then(function () { loadArchived(); }); } }, style: { fontSize: 11, cursor: "pointer", color: T.err } }, "彻底删除"))));
					})(s.archived[i]);
				}
				return react.createElement("aside", { style: C.drawer },
					react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "12px 12px 8px", borderBottom: "1px solid " + T.border1 } },
						react.createElement("span", { onClick: function () { store.showArchived = false; emit(); }, style: { cursor: "pointer", color: T.brand, fontSize: 12 } }, "← 返回"),
						react.createElement("b", { style: { fontSize: 13 } }, "历史记录")),
					react.createElement("div", { style: { flex: 1, overflow: "auto", paddingTop: 4 } },
						s.archived.length ? arch : react.createElement("div", { style: { padding: 14, color: T.label2, fontSize: 12 } }, "(暂无已删除的群)")));
			}

			var items = [];
			for (var i = 0; i < s.rooms.length; i++) {
				(function (room) {
					var act = s.activeId === room.id;
					items.push(react.createElement("div", {
						key: room.id,
						onClick: function () { setActive(room.id); },
						style: { padding: "8px 12px", display: "flex", alignItems: "center", gap: 7, cursor: "pointer", borderLeft: "2px solid " + (act ? T.brand : "transparent"), background: act ? tint(T.brand, 16) : "transparent", fontWeight: act ? 600 : 400, color: T.label1 },
					},
						react.createElement("span", { style: { color: T.brand, fontWeight: 700 } }, "#"),
						react.createElement("span", { style: { flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, room.name)));
				})(s.rooms[i]);
			}
			return react.createElement("aside", { style: C.drawer },
				react.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 12px 8px", borderBottom: "1px solid " + T.border1 } },
					react.createElement("b", null, "智能体协作台"),
					react.createElement("span", { onClick: function () { setOpen(false); }, style: { cursor: "pointer", color: T.label2 } }, "«")),
				react.createElement("div", { style: { flex: 1, overflow: "auto", paddingTop: 6 } }, items),
				react.createElement("div", { onClick: function () { store.showArchived = true; loadArchived(); emit(); }, style: { padding: "10px 12px", borderTop: "1px solid " + T.border1, color: T.label2, fontSize: 12, cursor: "pointer" } }, "🗂 历史记录（已删群）"),
				react.createElement("div", { style: { padding: "10px 12px", display: "flex", gap: 6, borderTop: "1px solid " + T.border1 } },
					react.createElement("input", { placeholder: "新群名称", value: newName, onChange: function (e) { setNewName(e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter") createRoom(); }, style: { flex: 1, background: T.bgBase, border: "1px solid " + T.border2, borderRadius: 6, color: T.label1, padding: "6px 8px", fontSize: 12, minWidth: 0 } }),
					react.createElement("button", { onClick: createRoom, style: { ...BTN, background: T.brand, borderColor: T.brand, color: "#fff" } }, "建群")));
		}

		// ---- 聊天区 ----
		function Chat(props) {
			var s = props.s;
			var d = s.detail || {};
			var room = d.room || {};
			var members = d.members || [];
			var messages = d.messages || [];
			var approvals = d.pending_approvals || [];
			var running = d.running_task;
			var textState = react.useState("");
			var text = textState[0], setText = textState[1];
			var sendState = react.useState(false);
			var sending = sendState[0], setSending = sendState[1];
			var inputRef = react.useRef(null);
			var mentionState = react.useState({ open: false, kw: "", start: -1, m0len: 0, index: 0, count: 0 });
			var mention = mentionState[0], setMention = mentionState[1];
			function closeMention() { setMention({ open: false, kw: "", start: -1, m0len: 0, index: 0, count: 0 }); }
			function mentionHits() {
				if (!members.length) return [];
				var kw = mention.kw || "";
				return members.filter(function (x) { return (x.name || "").indexOf(kw) !== -1; });
			}
			function pickMentionAt(idx) {
				var hits = mentionHits();
				var target = hits[idx];
				if (!target) { closeMention(); return; }
				var before = text.slice(0, mention.start);
				var after = text.slice(mention.start + mention.m0len);
				var next = before + "@" + target.name + " " + after;
				setText(next);
				closeMention();
				if (inputRef.current) {
					inputRef.current.focus();
					var cp = before.length + target.name.length + 2;
					try { inputRef.current.setSelectionRange(cp, cp); } catch (e) { /* ignore */ }
				}
			}
			function onInputChange(e) {
				var v = e.target.value;
				setText(v);
				var pos = e.target.selectionStart || 0;
				var m = v.slice(0, pos).match(/@([\w一-龥]*)$/);
				if (m) {
					var kw = m[1] || "";
					var hits = members.filter(function (x) { return (x.name || "").indexOf(kw) !== -1; });
					if (hits.length) setMention({ open: true, kw: kw, start: pos - m[0].length, m0len: m[0].length, index: 0, count: hits.length });
					else closeMention();
				} else {
					closeMention();
				}
			}
			function onInputKeyDown(e) {
				if (mention.open) {
					var hits = mentionHits();
					if (e.key === "ArrowDown") { e.preventDefault(); setMention({ ...mention, index: Math.min(mention.index + 1, Math.max(hits.length - 1, 0)) }); return; }
					if (e.key === "ArrowUp") { e.preventDefault(); setMention({ ...mention, index: Math.max(mention.index - 1, 0) }); return; }
					if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); pickMentionAt(mention.index); return; }
					if (e.key === "Escape") { closeMention(); return; }
				}
				if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
			}

			function doSend() {
				var v = (text || "").trim();
				if (!v || !s.activeId || sending) return;
				setSending(true);
				sendMessage(v).then(function () {
					setText(""); setSending(false); refresh();
				}).catch(function () { setSending(false); });
			}
			function doBrain() {
				var v = (text || "").trim();
				if (!v || !s.activeId || sending) return;
				setSending(true);
				sendToBrain(v).then(function () {
					setText(""); setSending(false); refresh();
				}).catch(function () { setSending(false); });
			}

			var msgs = [];
			for (var i = 0; i < messages.length; i++) {
				(function (m) {
					var isHuman = m.sender_type === "human" || m.sender_name === "我";
					var isSystem = m.sender_type === "system";
					var who = m.member_name || m.sender_name || m.sender_type || "";
					var bubble;
					if (isSystem) {
						bubble = react.createElement("div", { style: { alignSelf: "flex-start", background: "transparent", border: "1px dashed " + T.border2, color: T.label2, padding: "6px 12px", borderRadius: 10, fontSize: 12, maxWidth: "92%", whiteSpace: "pre-wrap" } }, String(m.content || "").slice(0, 4000));
					} else {
						var color = isHuman ? T.brand : colorOf(who);
						bubble = react.createElement("div", {
							style: { display: "flex", flexDirection: "column", alignItems: isHuman ? "flex-end" : "flex-start", maxWidth: "84%", alignSelf: isHuman ? "flex-end" : "flex-start", margin: "5px 0" },
						},
							react.createElement("div", { style: { fontSize: 11, color: T.label2, marginBottom: 2 } },
								react.createElement("span", { style: { color: color, fontWeight: 600 } }, isHuman ? "我" : who),
								" · " + fmtTime(m.created_at)),
							react.createElement("div", { style: { background: isHuman ? tint(T.brand, 18) : T.layer1, border: isHuman ? "none" : "1px solid " + T.border1, color: T.label1, padding: "8px 12px", borderRadius: 10, lineHeight: 1.5, whiteSpace: "pre-wrap" } }, String(m.content || "")));
					}
					msgs.push(bubble);
				})(messages[i]);
			}

			var approvalBar = null;
			if (approvals.length) {
				var a = approvals[0];
				var planText = "", planDispatch = "";
				try {
					var pobj = JSON.parse(a.plan_json || "{}");
					planText = String(pobj.plan || "");
					var disp = pobj.dispatch || [];
					if (Array.isArray(disp)) {
						planDispatch = disp.map(function (x) { return "@" + (x.member_name || x.name || x.member || "?"); }).join(" ");
					}
				} catch (e) { planText = String(a.plan_json || ""); }
				approvalBar = react.createElement("div", { style: { margin: "10px 14px 0", background: tint(T.warn, 10), border: "1px solid " + T.warn, borderRadius: 8, padding: "10px 12px" } },
					react.createElement("div", { style: { color: T.warn, fontWeight: 600, marginBottom: 4 } }, "待审批 · 第 " + (a.round || 1) + " 轮"),
					react.createElement("div", { style: { fontSize: 12, color: T.label2, marginBottom: planDispatch ? 2 : 8 } }, String(planText).slice(0, 160)),
					planDispatch ? react.createElement("div", { style: { fontSize: 12, color: T.label2, marginBottom: 8 } }, "分派: " + planDispatch) : null,
					react.createElement("div", { style: { display: "flex", gap: 8 } },
						react.createElement("button", { onClick: function () { actApproval(a, "approve"); }, style: { ...BTN, background: T.brand, borderColor: T.brand, color: "#fff" } }, "确认执行"),
						react.createElement("button", { onClick: function () { actApproval(a, "reject"); }, style: { ...BTN, borderColor: T.err, color: T.err } }, "否决")));
			}

			function actApproval(a, act) {
				fetch("/agent-hub/approvals/" + a.id + "/" + act, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
					.then(function (r) { return r.json(); })
					.then(function () { if (s.activeId) loadDetail(s.activeId); })
					.catch(function () {});
			}

			return react.createElement("main", { style: C.chat },
				react.createElement("div", { style: { height: 50, display: "flex", alignItems: "center", gap: 12, padding: "0 14px", borderBottom: "1px solid " + T.border1, background: T.layer2, flexShrink: 0 } },
					react.createElement("span", { style: { color: T.brand, fontSize: 16, fontWeight: 700 } }, "#"),
					react.createElement("span", { style: { fontWeight: 700, fontSize: 14 } }, room.name || "请选择房间"),
					room.orchestrator_member_id ? react.createElement("span", { style: { color: T.label2, fontSize: 12, whiteSpace: "nowrap" } }, "🧠 大脑已设置") : null,
					react.createElement("span", { style: { flex: 1 } }),
					react.createElement("label", { style: { display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: T.label2, cursor: "pointer", whiteSpace: "nowrap" } },
						react.createElement("input", { type: "checkbox", checked: !!room.auto_approve, onChange: function (e) { setAutoApprove(e.target.checked); }, style: { cursor: "pointer" } }),
						"自动批准持续任务"),
					running ? react.createElement("button", { onClick: function () { stopTask(running.id).then(refresh); }, style: { ...BTN, borderColor: T.err, color: T.err, padding: "2px 10px" } }, "叫停") : null,
					react.createElement("button", { onClick: function () { if (window.confirm("确认删除本群?将移入历史归档,可恢复。")) { delJson("/agent-hub/room/" + s.activeId).then(function () { store.activeId = null; store.detail = null; emit(); loadRooms(); }); } }, style: { ...BTN, borderColor: T.err, color: T.err, padding: "2px 10px" } }, "删除群")),
				approvalBar,
				react.createElement("div", { style: { flex: 1, overflow: "auto", padding: 14, display: "flex", flexDirection: "column" } },
					!d.messages && !d.error ? react.createElement("div", { style: { color: T.label2 } }, "加载中…") : null,
					d.error ? react.createElement("div", { style: { color: T.err } }, "读取失败: " + d.error) : msgs),
				react.createElement("div", { style: { position: "relative", borderTop: "1px solid " + T.border1, padding: "10px 14px", background: T.layer2, flexShrink: 0 } },
					mention.open ? react.createElement("div", { style: { position: "absolute", bottom: "100%", left: 14, right: 14, marginBottom: 6, background: T.overlay, border: "1px solid " + T.border2, borderRadius: 8, boxShadow: "0 6px 24px rgba(0,0,0,.35)", overflow: "hidden", zIndex: 20 } },
						mentionHits().map(function (mm, idx) {
							return react.createElement("div", {
								key: mm.id,
								onMouseDown: function (ev) { ev.preventDefault(); pickMentionAt(idx); },
								style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", cursor: "pointer", background: idx === mention.index ? tint(T.brand, 18) : "transparent", color: T.label1, fontSize: 12 },
							},
								react.createElement("span", { style: { width: 18, height: 18, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#fff", background: colorOf(mm.name), flexShrink: 0 } }, String(mm.name || "?").charAt(0)),
								react.createElement("span", { style: { flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, mm.name),
								react.createElement("span", { style: { fontSize: 10, color: T.label2 } }, TYPE_NAMES[mm.type] || mm.type));
						})) : null,
					react.createElement("div", { style: { display: "flex", gap: 8, alignItems: "flex-end" } },
						react.createElement("textarea", {
							ref: inputRef,
							value: text,
							placeholder: s.activeId ? "输入消息,回车发送;输入 @ 弹出成员选择;Shift+回车换行;可拖拽右下角调高" : "请先选择左侧房间",
							disabled: !s.activeId,
							rows: 3,
							onChange: onInputChange,
							onKeyDown: onInputKeyDown,
							style: { flex: 1, background: T.bgBase, border: "1px solid " + T.border2, borderRadius: 8, color: T.label1, padding: "8px 10px", fontSize: 13, lineHeight: 1.4, resize: "vertical", overflow: "auto", minHeight: 48, maxHeight: 320, fontFamily: "inherit", outline: "none" },
						}),
						react.createElement("button", {
							onClick: doBrain,
							disabled: !s.activeId || sending || !(text || "").trim(),
							title: "把输入作为需求发给统筹大脑,启动自主组织-决策-执行循环",
							style: { background: "transparent", border: "1px solid " + T.brand, color: T.brand, borderRadius: 8, padding: "8px 12px", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" },
						}, "发给大脑"),
						react.createElement("button", {
							onClick: doSend,
							disabled: !s.activeId || sending || !(text || "").trim(),
							style: { background: T.brand, border: "none", color: "#fff", borderRadius: 8, padding: "9px 16px", cursor: "pointer", fontSize: 13, fontWeight: 600 },
						}, sending ? "发送中…" : "发送")),
					react.createElement("div", { style: { marginTop: 6, fontSize: 11, color: T.label2 } }, "发送=普通消息(@成员名 派发任务) · 发给大脑=启动自主决策循环 · 自动批准已开启时每轮计划无需人工确认")));
		}

		// ---- 成员面板 ----
		var TYPE_LABELS = { openai: "OpenAI 兼容", dsh: "DSH Agent" };
		function Members(props) {
			var s = props.s;
			var d = s.detail || {};
			var members = d.members || [];
			var room = d.room || {};
			var formState = react.useState({ type: "openai", name: "", base_url: "", api_key: "", model: "", dsh_base_url: "", dsh_token: "", pat_token: "", bot_id: "" });
			var form = formState[0], setForm = formState[1];
			var invState = react.useState("");
			var invite = invState[0], setInvite = invState[1];
			function setF(k, v) { var nf = {}; for (var kk in form) nf[kk] = form[kk]; nf[k] = v; setForm(nf); }
			function doAdd() {
				if (!(form.name || "").trim() || !s.activeId) return;
				postJson("/agent-hub/room/" + s.activeId + "/members", {
					name: form.name.trim(), type: form.type,
					base_url: form.base_url.trim(), api_key: form.api_key.trim(), model: form.model.trim(),
					dsh_base_url: form.dsh_base_url.trim(), dsh_token: form.dsh_token.trim(),
					pat_token: form.pat_token.trim(), bot_id: form.bot_id.trim(),
				}).then(function () {
					var nf = { type: form.type, name: "", base_url: "", api_key: "", model: "", dsh_base_url: "", dsh_token: "", pat_token: "", bot_id: "" };
					setForm(nf); refresh();
				}).catch(function () {});
			}
			function doInvite() {
				var v = (invite || "").trim();
				if (!v || !s.activeId) return;
				postJson("/agent-hub/room/" + s.activeId + "/members/invite_string", { invite: v }).then(function () {
					setInvite(""); refresh();
				}).catch(function () {});
			}
			var inp = { background: T.bgBase, border: "1px solid " + T.border2, borderRadius: 6, color: T.label1, padding: "5px 8px", fontSize: 12, minWidth: 0, outline: "none" };
			return react.createElement("aside", { style: C.members },
				react.createElement("div", { style: { padding: "12px 14px", borderBottom: "1px solid " + T.border1 } },
					react.createElement("div", { style: { fontWeight: 700, fontSize: 11, color: T.label2, textTransform: "uppercase", letterSpacing: .5, marginBottom: 8 } }, "成员 (" + members.length + ")"),
					members.map(function (m) {
						var isBrain = room.orchestrator_member_id === m.id;
						return react.createElement("div", { key: m.id, style: { padding: "6px 0", borderBottom: "1px solid " + T.border1 } },
							react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
								react.createElement("span", { style: { width: 22, height: 22, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#fff", background: colorOf(m.name), flexShrink: 0 } }, String(m.name || "?").charAt(0)),
								react.createElement("span", { style: { flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: T.label1 } }, m.name),
								isBrain ? react.createElement("span", { style: { fontSize: 10, fontWeight: 700, color: T.brand, border: "1px solid " + T.brand, background: tint(T.brand, 16), borderRadius: 4, padding: "1px 5px" } }, "🧠 大脑") : null,
								react.createElement("span", { style: { fontSize: 10, color: T.label2, border: "1px solid " + T.border2, borderRadius: 4, padding: "1px 5px" } }, TYPE_NAMES[m.type] || m.type)),
							react.createElement("div", { style: { display: "flex", gap: 10, marginTop: 3, paddingLeft: 30 } },
								react.createElement("span", { onClick: function () { setOrchestrator(isBrain ? null : m.id).then(refresh); }, style: { fontSize: 11, cursor: "pointer", color: T.brand } }, isBrain ? "取消大脑" : "设为大脑"),
								react.createElement("span", { onClick: function () { if (window.confirm("确认移除成员「" + m.name + "」?")) removeMember(m.id).then(refresh); }, style: { fontSize: 11, cursor: "pointer", color: T.err } }, "移除")));
					})),
				react.createElement("div", { style: { padding: "12px 14px", borderBottom: "1px solid " + T.border1 } },
					react.createElement("div", { style: { fontWeight: 700, fontSize: 11, color: T.label2, textTransform: "uppercase", letterSpacing: .5, marginBottom: 8 } }, "邀请成员"),
					react.createElement("div", { style: { display: "flex", gap: 6, marginBottom: 6 } },
						react.createElement("select", { value: form.type, onChange: function (e) { setF("type", e.target.value); }, style: { ...inp, flex: 1 } },
							["openai", "dsh"].map(function (t) {
								return react.createElement("option", { key: t, value: t }, TYPE_LABELS[t] || t);
							})),
						form.type === "openai" ? react.createElement("input", { placeholder: "成员名", value: form.name, onChange: function (e) { setF("name", e.target.value); }, style: { ...inp, flex: 1 } }) : null),
					form.type === "openai" ? react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 6 } },
						react.createElement("input", { placeholder: "base_url(如 https://api.deepseek.com/v1)", value: form.base_url, onChange: function (e) { setF("base_url", e.target.value); }, style: inp }),
						react.createElement("input", { placeholder: "api_key", value: form.api_key, onChange: function (e) { setF("api_key", e.target.value); }, style: inp }),
						react.createElement("input", { placeholder: "model(如 deepseek-chat)", value: form.model, onChange: function (e) { setF("model", e.target.value); }, style: inp })) : null,
					form.type === "dsh" ? react.createElement("div", { style: { background: T.bgBase, border: "1px dashed " + T.brand, borderRadius: 8, padding: "10px 12px", marginBottom: 6, fontSize: 12, color: T.label1, lineHeight: 1.7 } },
						react.createElement("div", { style: { fontWeight: 700, color: T.brand, marginBottom: 4 } }, "DSH Agent 接入方式"),
						"DSH 成员通过目标 DSH 会话内的工具接入,无需在此填写表单。让任意 DSH 会话的智能体执行:",
						react.createElement("div", { style: { background: T.layer1, border: "1px solid " + T.border1, borderRadius: 6, padding: "6px 10px", marginTop: 8, fontFamily: "Consolas, monospace", fontSize: 11, whiteSpace: "pre-wrap", color: T.label1 } }, "trd_connect(roomName=\"" + (room.name || "本群名") + "\")"),
						react.createElement("div", { style: { color: T.label2, marginTop: 8, fontSize: 11 } }, "接入成功后自动出现在上方成员列表(成员名=你填的显示名)。")) : null,
					form.type === "openai" ? react.createElement("button", { onClick: doAdd, disabled: !s.activeId || !(form.name || "").trim(), style: { ...BTN, background: T.brand, borderColor: T.brand, color: "#fff", width: "100%" } }, "添加成员") : null,
					react.createElement("div", { style: { display: "flex", gap: 6, marginTop: 8 } },
						react.createElement("input", { placeholder: "邀约字符串(TRD|openai|…)", value: invite, onChange: function (e) { setInvite(e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter") doInvite(); }, style: { ...inp, flex: 1 } }),
						react.createElement("button", { onClick: doInvite, disabled: !s.activeId || !(invite || "").trim(), style: BTN }, "解析加入"))),
				react.createElement("div", { style: { padding: "12px 14px", borderTop: "1px solid " + T.border1 } },
					react.createElement("div", { style: { fontWeight: 700, fontSize: 11, color: T.label2, textTransform: "uppercase", letterSpacing: .5, marginBottom: 6 } }, "群记忆（大脑沉淀）"),
					react.createElement("div", { style: { background: T.layer1, border: "1px solid " + T.border1, borderRadius: 6, padding: "8px 10px", fontSize: 12, lineHeight: 1.5, minHeight: 56, color: room.memory ? T.label1 : T.label2 } }, room.memory || "(暂无)")));
		}

		// ---- 首次安装/后端未就绪引导页 ----
		function SetupPanel(props) {
			var b = props.s.backend || {};
			var title, detail;
			if (b.status === "no-python") {
				title = "需要安装 Python";
				detail = "智能体协作台内置后端需要 Python 3.10+。\n请先安装 Python(勾选 Add to PATH),然后点「刷新重试」。";
			} else if (b.status === "no-subprocess") {
				title = "后端启动器不可用";
				detail = "当前 DSH 环境未提供 subprocess 服务,无法自动启动内置后端。\n可手动运行插件目录 backend/start.py。";
			} else if (b.status === "start-failed") {
				title = "后端启动失败";
				detail = b.message || "内置后端启动失败。\n可手动运行 backend/start.py 查看原因。";
			} else if (b.status === "unknown" || !b.status) {
				title = "正在连接后端…";
				detail = "正在检测 TRD 后端状态,请稍候…";
			} else {
				title = "正在启动 TRD 后端";
				detail = b.message || "正在自动创建虚拟环境并安装依赖(首次约 1-2 分钟),完成前请稍候…";
			}
			return react.createElement("div", { style: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center" } },
				react.createElement("div", { style: { maxWidth: 480, width: "100%", margin: 24, background: T.layer1, border: "1px solid " + T.border1, borderRadius: 12, padding: "26px 28px", color: T.label1 } },
					react.createElement("div", { style: { fontSize: 16, fontWeight: 700, marginBottom: 10 } }, title),
					react.createElement("div", { style: { fontSize: 13, color: T.label2, lineHeight: 1.7, marginBottom: 18, whiteSpace: "pre-wrap" } }, detail),
					react.createElement("div", { style: { display: "flex", gap: 10 } },
						react.createElement("button", { onClick: function () { fetch("/agent-hub/health?force=1").then(function () { location.reload(); }).catch(function () { location.reload(); }); }, style: { ...BTN, background: T.brand, borderColor: T.brand, color: "#fff" } }, "刷新重试"),
						react.createElement("button", { onClick: function () { setOpen(false); }, style: BTN }, "收起"))));
		}

		// ---- 无群时的欢迎/使用指引 ----
		function WelcomePanel(props) {
			var nameState = react.useState("");
			var newName = nameState[0], setNewName = nameState[1];
			return react.createElement("div", { style: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto" } },
				react.createElement("div", { style: { maxWidth: 520, width: "100%", margin: 24, background: T.layer1, border: "1px solid " + T.border1, borderRadius: 12, padding: "26px 28px", color: T.label1 } },
					react.createElement("div", { style: { fontSize: 17, fontWeight: 700, marginBottom: 12 } }, "👋 欢迎使用「智能体协作台」"),
					react.createElement("div", { style: { fontSize: 13, color: T.label2, lineHeight: 1.8, whiteSpace: "pre-wrap", marginBottom: 18 } }, WELCOME_TEXT),
					react.createElement("div", { style: { display: "flex", gap: 8 } },
						react.createElement("input", { placeholder: "给第一个群起个名字…", value: newName, onChange: function (e) { setNewName(e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter") { createRoomNamed(newName).then(function (r) { if (r) setNewName(""); }); } }, style: { flex: 1, background: T.bgBase, border: "1px solid " + T.border2, borderRadius: 8, color: T.label1, padding: "8px 10px", fontSize: 13, outline: "none" } }),
						react.createElement("button", { onClick: function () { createRoomNamed(newName).then(function (r) { if (r) setNewName(""); }); }, style: { background: T.brand, border: "none", color: "#fff", borderRadius: 8, padding: "0 16px", cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" } }, "创建群"))));
		}

		// ---- 总控制台 ----
		function Console() {
			var s = useStore();
			var overlayRef = react.useRef(null);
			react.useEffect(function () {
				if (!s.open) return;
				function checkHealth() {
					fetch("/agent-hub/health").then(function (r) { return r.json(); }).then(function (h) {
						store.backend = h || { ok: false, status: "unknown" };
						emit();
						if (h && h.ok) { loadRooms(); if (store.activeId) loadDetail(store.activeId); }
					}).catch(function () {});
				}
				checkHealth();
				var hh = setInterval(checkHealth, 3000);
				var t = setInterval(function () { if (store.backend && store.backend.ok && store.activeId) loadDetail(store.activeId); }, 2000);
				return function () { clearInterval(hh); clearInterval(t); };
			}, [s.open]);
			// 点击面板外部(左侧 DSH 侧栏会话)时自动收起,恢复原对话面板
			react.useEffect(function () {
				if (!s.open) return;
				function onDocClick(e) {
					var el = e && e.target;
					if (el && el.closest && el.closest("[data-trd-hub-toggle]")) return; // 开关按钮自己处理
					if (overlayRef.current && !overlayRef.current.contains(el)) setOpen(false);
				}
				document.addEventListener("click", onDocClick, true);
				return function () { document.removeEventListener("click", onDocClick, true); };
			}, [s.open]);
			if (!s.open) return null;
			var ok = !!(s.backend && s.backend.ok);
			return react.createElement("div", { style: C.overlay, ref: overlayRef },
				!ok
					? react.createElement(SetupPanel, { key: "s", s: s })
					: (s.rooms.length === 0
						? react.createElement(WelcomePanel, { key: "w", s: s })
						: [react.createElement(Drawer, { key: "d", s: s }), react.createElement(Chat, { key: "c", s: s }), react.createElement(Members, { key: "m", s: s })]));
		}

		// ---- 侧栏开关按钮(深浅态区分展开/收起,跟随主题) ----
		function ToggleButton() {
			var s = useStore();
			var active = s.open;
			return react.createElement("button", {
				onClick: function () { setOpen(!store.open); },
				"data-trd-hub-toggle": "1",
				title: active ? "收起智能体协作台" : "打开智能体协作台(多智能体房间/群聊)",
				style: {
					marginLeft: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap", borderRadius: 6,
					background: active ? tint(T.brand, 22) : "transparent",
					color: active ? T.brand : T.label1,
					border: "1px solid " + (active ? T.brand : T.border2),
				},
			}, active ? "智能体协作台 ●" : "智能体协作台");
		}

		// ---- 注册 Slot ----
		var inject = ["slots"];
		function apply(ctx) {
			var slots = ctx.slots;
			slots.inject("sidebar.footer.action", function () {
				return slots.register(
					{ name: "sidebar.footer.action", id: "dsh-agent-hub", order: 40, label: "智能体协作台" },
					function () { return react.createElement(ToggleButton, null); });
			});
			slots.inject("shell.overlay", function () {
				return slots.register(
					{ name: "shell.overlay", id: "dsh-agent-hub-console", order: 40 },
					function () { return react.createElement(Console, null); });
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
