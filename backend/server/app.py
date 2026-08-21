"""FastAPI 入口：REST（房间/成员/邀约/消息/附件/审批/中继）+ WebSocket + 静态页托管。"""
import asyncio
import os
import secrets

import yaml
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import charter, db, orchestrator, router

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(BASE_DIR, "config.yaml"), "r", encoding="utf-8") as f:
    CFG = yaml.safe_load(f)

DATA_DIR = os.path.join(BASE_DIR, CFG.get("data_dir", "data"))
db.init(DATA_DIR)
orchestrator.init(CFG)

app = FastAPI(title="任务中继分发器")

# ---------- WebSocket 广播 ----------
_WS: dict[str, set[WebSocket]] = {}


async def _broadcast(room_id: str, payload: dict):
    dead = []
    for ws in _WS.get(room_id, set()):
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _WS.get(room_id, set()).discard(ws)


router.set_broadcaster(_broadcast)

# ---------- relay 状态机初始化与僵死清理 ----------
from .adapters import human_relay as _hr
from .adapters import dsh as _dsh

_hr.init(CFG["limits"].get("relay_stale_sec", 1800))


@app.on_event("startup")
async def _start_relay_cleanup():
    asyncio.create_task(_hr.cleanup_stale())


@app.websocket("/ws/{room_id}")
async def ws(websocket: WebSocket, room_id: str):
    await websocket.accept()
    _WS.setdefault(room_id, set()).add(websocket)
    try:
        while True:
            await websocket.receive_text()  # 保持连接，客户端无需上行
    except WebSocketDisconnect:
        _WS.get(room_id, set()).discard(websocket)


# ---------- 房间 ----------
class RoomIn(BaseModel):
    name: str
    auto_approve: bool = False


@app.get("/api/archived_rooms")
def archived_rooms():
    """历史归档：已删除群列表（含成员/消息统计）。"""
    return db.list_archived_rooms()


@app.get("/api/rooms")
def list_rooms():
    return db.list_rooms()


# ---------- 全局协作章程 ----------
class CharterIn(BaseModel):
    text: str


@app.get("/api/charter")
def get_charter():
    """读取全局协作章程全文(注入大脑与成员的最高协作约束)。"""
    return {"text": charter.get_charter()}


@app.put("/api/charter")
def put_charter(body: CharterIn):
    """整体覆盖全局协作章程(运行中热生效)。"""
    charter.set_charter(body.text)
    return {"ok": True, "length": len(body.text.strip())}


# 新群默认写入的通用接入指引(覆盖各类型 Agent,非 DSH 专属)
ONBOARDING_GUIDE = (
    "👋 欢迎使用智能体协作台!本群已创建,以下是接入与使用指引。\n\n"
    "【添加成员(多种 Agent 类型)】\n"
    "在右侧成员栏点击「邀约 Agent 入群」按类型填写配置,或直接粘贴邀约字符串:\n"
    "- DSH Agent:  TRD|dsh|<端点>|<Token>|<显示名>\n"
    "- OpenAI 兼容:TRD|openai|<base_url>|<api_key>|<model>|<显示名>\n"
    "- 扣子 Coze / WorkBuddy / Trae: 在成员栏选类型并填对应配置。\n\n"
    "【如何派单】\n"
    "- 输入框 @成员名 发送 → 定向派给该成员。\n"
    "- 点「发给大脑」→ 把需求交给统筹大脑,由其自动拆解、分工、监督、验收,按轮次推进。\n"
    "- 勾选「自动批准持续任务」→ 大脑每轮计划无需人工逐轮确认。\n\n"
    "【推荐流程】\n"
    "1. 在成员栏把一名成员「设为大脑」;2. 输入目标 → 点「发给大脑」;"
    "3. 大脑自主决策、分派、验收直至交付(可随时「叫停」)。"
)


@app.post("/api/rooms")
def create_room(body: RoomIn):
    if not body.name.strip():
        raise HTTPException(400, "房间名不能为空")
    room = db.create_room(body.name.strip(), body.auto_approve)
    db.add_message(room["id"], "system", "系统", ONBOARDING_GUIDE)
    return room


@app.get("/api/rooms/{room_id}")
def room_detail(room_id: str):
    room = db.get_room(room_id)
    if not room:
        raise HTTPException(404, "房间不存在")
    return {"room": room, "members": db.list_members(room_id),
            "messages": db.list_messages(room_id),
            "pending_approvals": db.pending_approvals(room_id),
            "running_task": db.running_task(room_id)}


class AutoApproveIn(BaseModel):
    flag: bool


@app.delete("/api/rooms/{room_id}")
async def delete_room(room_id: str):
    """软删除：叫停运行中任务后移入历史归档，数据全保留可恢复。"""
    room = db.get_room(room_id)
    if not room:
        raise HTTPException(404, "房间不存在")
    t = db.running_task(room_id)
    if t:
        orchestrator.stop_task(t["id"])
    # 无论是否有编排任务在跑，都取消该房间所有挂起的中继并通知 Agent
    for m in db.list_members(room_id):
        if m["type"] in ("relay", "trae", "workbuddy"):
            await _hr.cancel_with_notify(m)
    _dsh.cancel_room(room_id)
    db.soft_delete_room(room_id)
    return {"ok": True}


@app.post("/api/rooms/{room_id}/restore")
def restore_room(room_id: str):
    room = db.get_room(room_id)
    if not room:
        raise HTTPException(404, "房间不存在")
    db.restore_room(room_id)
    return {"ok": True}


@app.delete("/api/rooms/{room_id}/purge")
def purge_room(room_id: str):
    """彻底删除：仅在归档中操作，数据不可恢复。"""
    room = db.get_room(room_id)
    if not room:
        raise HTTPException(404, "房间不存在")
    if not room.get("deleted_at"):
        raise HTTPException(400, "请先删除到历史归档，再彻底删除")
    db.purge_room(room_id)
    return {"ok": True}


class MemoryIn(BaseModel):
    memory: str


@app.put("/api/rooms/{room_id}/memory")
def update_memory(room_id: str, body: MemoryIn):
    """人类手动编辑群记忆（大脑每轮也会自动沉淀）。"""
    if not db.get_room(room_id):
        raise HTTPException(404, "房间不存在")
    db.set_memory(room_id, body.memory)
    return {"ok": True}


@app.post("/api/rooms/{room_id}/auto_approve")
def set_auto_approve(room_id: str, body: AutoApproveIn):
    if not db.get_room(room_id):
        raise HTTPException(404, "房间不存在")
    db.set_auto_approve(room_id, body.flag)
    return {"ok": True}


class OrchestratorIn(BaseModel):
    member_id: str | None = None   # None 表示取消指定，回退 config.yaml 大脑


@app.post("/api/rooms/{room_id}/orchestrator")
def set_orchestrator(room_id: str, body: OrchestratorIn):
    if not db.get_room(room_id):
        raise HTTPException(404, "房间不存在")
    if body.member_id:
        m = db.get_member(body.member_id)
        if not m or m["room_id"] != room_id:
            raise HTTPException(400, "成员不属于该房间")
    db.set_orchestrator(room_id, body.member_id)
    return {"ok": True}


# ---------- 成员与邀约 ----------
class MemberIn(BaseModel):
    name: str
    type: str                 # openai | coze | dsh | relay | trae | workbuddy
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None
    pat_token: str | None = None
    bot_id: str | None = None
    dsh_base_url: str | None = None
    dsh_token: str | None = None


def _member_out(m: dict) -> dict:
    """对外返回成员信息：不含凭据；relay 型附邀约链接与回调地址。"""
    out = {k: m[k] for k in ("id", "room_id", "name", "type", "invite_token")}
    out["callback_url"] = m.get("callback_url")
    if m["type"] in ("relay", "trae", "workbuddy") and m.get("invite_token"):
        out["relay_url"] = f"/relay.html?token={m['invite_token']}"
        out["bridge_poll_url"] = f"/api/bridge/{m['invite_token']}/poll"
        out["bridge_submit_url"] = f"/api/bridge/{m['invite_token']}/submit"
    if m["type"] == "dsh":
        import json as _json
        try:
            cfg = _json.loads(m.get("config") or "{}")
            out["dsh_base_url"] = cfg.get("endpoint") or cfg.get("base_url") or ""
        except Exception:
            out["dsh_base_url"] = ""
    return out


@app.post("/api/rooms/{room_id}/members")
def add_member(room_id: str, body: MemberIn):
    if not db.get_room(room_id):
        raise HTTPException(404, "房间不存在")
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "成员名不能为空")
    if any(m["name"] == name for m in db.list_members(room_id)):
        raise HTTPException(400, "成员名在群内已存在")
    if body.type == "openai":
        if not (body.base_url and body.api_key and body.model):
            raise HTTPException(400, "openai 型成员需要 base_url/api_key/model")
        config = {"base_url": body.base_url, "api_key": body.api_key, "model": body.model}
        m = db.add_member(room_id, name, "openai", config)
    elif body.type == "coze":
        if not (body.pat_token and body.bot_id):
            raise HTTPException(400, "coze 型成员需要 pat_token/bot_id")
        m = db.add_member(room_id, name, "coze",
                          {"pat_token": body.pat_token, "bot_id": body.bot_id})
    elif body.type == "dsh":
        if not (body.dsh_token and body.dsh_token.strip()):
            raise HTTPException(400, "dsh 型成员需要 dsh_token(DSH 面板/trd_card 获取)")
        # dsh_base_url 现在允许填「完整端点」(如 http://127.0.0.1:3080/trd-agent/xxxx),兼容旧格式
        ep = (body.dsh_base_url or "http://127.0.0.1:3080/trd-agent").strip().rstrip("/")
        if not ep.startswith(("http://", "https://")):
            raise HTTPException(400, "dsh_base_url 必须是 http(s) 地址")
        srv_host = CFG["server"]["host"] or "127.0.0.1"
        if srv_host == "0.0.0.0":
            srv_host = "127.0.0.1"   # 回执回调必须走回环可达地址
        self_base = f"http://{srv_host}:{CFG['server']['port']}"
        m = db.add_member(room_id, name, "dsh",
                          {"endpoint": ep, "token": body.dsh_token.strip(),
                           "self_base": self_base})
    elif body.type in ("relay", "trae", "workbuddy"):
        m = db.add_member(room_id, name, body.type, {}, invite_token=secrets.token_urlsafe(16))
    else:
        raise HTTPException(400, "未知成员类型")
    return _member_out(m)


class InviteStrIn(BaseModel):
    invite: str


@app.post("/api/rooms/{room_id}/members/invite_string")
def add_by_invite_string(room_id: str, body: InviteStrIn):
    """解析邀约字符串:
    API 型: TRD|openai|<base_url>|<api_key>|<model>|<显示名>
    DSH 型: TRD|dsh|<base_url>|<token>|<显示名>
    """
    parts = body.invite.strip().split("|")
    if not parts or parts[0] != "TRD":
        raise HTTPException(400, "邀约字符串必须以 TRD 开头")
    if len(parts) == 6 and parts[1] == "openai":
        _, _, base_url, api_key, model, name = parts
        return add_member(room_id, MemberIn(name=name, type="openai", base_url=base_url,
                                            api_key=api_key, model=model))
    if len(parts) == 5 and parts[1] == "dsh":
        _, _, base_url, token, name = parts
        return add_member(room_id, MemberIn(name=name, type="dsh",
                                            dsh_base_url=base_url, dsh_token=token))
    raise HTTPException(
        400, "邀约字符串格式: TRD|openai|base_url|api_key|model|显示名 "
             "或 TRD|dsh|base_url|token|显示名")


@app.delete("/api/members/{member_id}")
def remove_member(member_id: str):
    m = db.get_member(member_id)
    if not m:
        raise HTTPException(404, "成员不存在")
    with db._LOCK, db._CONN:
        db._CONN.execute("DELETE FROM members WHERE id=?", (member_id,))
        # 若被移除成员是房间大脑，同步清除指定
        db._CONN.execute(
            "UPDATE rooms SET orchestrator_member_id=NULL WHERE orchestrator_member_id=?",
            (member_id,))
    return {"ok": True}


# ---------- 消息与附件 ----------
class MessageIn(BaseModel):
    content: str
    file_ids: list[str] = []


@app.post("/api/rooms/{room_id}/messages")
async def post_message(room_id: str, body: MessageIn):
    if not db.get_room(room_id):
        raise HTTPException(404, "房间不存在")
    if not body.content.strip():
        raise HTTPException(400, "消息不能为空")
    msg = db.add_message(room_id, "human", "我", body.content.strip(), file_ids=body.file_ids)
    await router.broadcast(room_id, {"kind": "message", "message": msg})
    timeout = CFG["limits"]["round_timeout_sec"]
    asyncio.create_task(router.route_message(room_id, msg, timeout))
    return msg


@app.post("/api/rooms/{room_id}/files")
async def upload_file(room_id: str, file: UploadFile = File(...)):
    if not db.get_room(room_id):
        raise HTTPException(404, "房间不存在")
    safe_name = os.path.basename(file.filename or "unnamed")
    fid_path = os.path.join(DATA_DIR, "files", f"{secrets.token_hex(8)}_{safe_name}")
    with open(fid_path, "wb") as f:
        f.write(await file.read())
    return db.add_file(room_id, safe_name, fid_path)


@app.get("/api/files/{file_id}")
def download_file(file_id: str):
    f = db.get_file(file_id)
    if not f or not os.path.exists(f["path"]):
        raise HTTPException(404, "文件不存在")
    return FileResponse(f["path"], filename=f["filename"])


# ---------- 统筹大脑任务 ----------
class TaskIn(BaseModel):
    requirement: str


@app.post("/api/rooms/{room_id}/task")
async def start_task(room_id: str, body: TaskIn):
    if not db.get_room(room_id):
        raise HTTPException(404, "房间不存在")
    if not body.requirement.strip():
        raise HTTPException(400, "需求不能为空")
    if db.running_task(room_id):
        raise HTTPException(400, "已有任务在运行，请先叫停")
    return await orchestrator.start_task(room_id, body.requirement.strip())


@app.post("/api/tasks/{task_id}/stop")
async def stop_task(task_id: str):
    """叫停：必须 async，cancel() 里的 event.set() 需在事件循环线程执行。"""
    task = db.get_task(task_id)
    if not task:
        raise HTTPException(404, "任务不存在")
    orchestrator.stop_task(task_id)
    # 同步取消该房间所有挂起的人工中继，让编排循环尽快退出
    for m in db.list_members(task["room_id"]):
        if m["type"] in ("relay", "trae", "workbuddy"):
            await _hr.cancel_with_notify(m)
    # 同步取消该房间所有挂起的 DSH 桥任务
    _dsh.cancel_room(task["room_id"])
    msg = db.add_message(task["room_id"], "system", "系统", "任务已被人类叫停", task_id=task_id)
    await router.broadcast(task["room_id"], {"kind": "message", "message": msg})
    return {"ok": True}


# ---------- 审批 ----------
class ApproveIn(BaseModel):
    plan: dict | None = None   # 人类修改后的计划；空则按原计划执行


class RejectIn(BaseModel):
    reason: str = ""


@app.post("/api/approvals/{approval_id}/approve")
async def approve(approval_id: str, body: ApproveIn | None = None):
    await orchestrator.approve(approval_id, body.plan if body else None)
    return {"ok": True}


@app.post("/api/approvals/{approval_id}/reject")
async def reject(approval_id: str, body: RejectIn | None = None):
    await orchestrator.reject(approval_id, body.reason if body else "")
    return {"ok": True}


# ---------- 人工中继 ----------
@app.get("/api/relay/{token}")
def relay_info(token: str):
    m = db.get_member_by_token(token)
    if not m:
        raise HTTPException(404, "邀约链接无效")
    room = db.get_room(m["room_id"])
    # 获取当前任务信息（含 reply_token）
    task_info = _hr.pending_task(m["id"])
    return {"member": _member_out(m), "room_name": room["name"] if room else "",
            "waiting": task_info is not None,
            "reply_token": task_info["reply_token"] if task_info else None,
            "task": task_info["task"] if task_info else None,
            "messages": db.tail_messages(m["room_id"], 50)}


class RelayReplyIn(BaseModel):
    content: str
    reply_token: str | None = None


@app.post("/api/relay/{token}/reply")
async def relay_reply(token: str, body: RelayReplyIn):
    """中继回执：必须在事件循环线程内执行，event.set() 才能唤醒挂起的 chat()。"""
    m = db.get_member_by_token(token)
    if not m:
        raise HTTPException(404, "邀约链接无效")
    if not body.content.strip():
        raise HTTPException(400, "回复不能为空")
    ok, reason = _hr.submit_reply(m["id"], body.content.strip(), body.reply_token)
    if not ok:
        msgs = {
            "no_pending": "当前没有等待回复的任务",
            "already_done": "任务已提交，请勿重复发送",
            "token_mismatch": "reply_token 不匹配，请刷新中继页获取最新任务",
            "cancelled": "任务已被叫停",
            "stale": "任务已超时过期，请刷新中继页获取新任务",
        }
        raise HTTPException(400, msgs.get(reason, f"提交失败: {reason}"))
    return {"ok": True}


# ---------- Bridge 拉模式（第三方 Agent 全自动入群） ----------
@app.get("/api/bridge/{token}/poll")
async def bridge_poll(token: str, long: bool = False):
    """第三方 Agent 轮询取任务。

    短轮询：立即返回，waiting=true 时含 reply_token。
    长轮询（long=true）：hold 住连接最长 long_poll_timeout 秒，
    有任务立即返回，无任务超时返回空。减少空转，任务到达即推。
    """
    m = db.get_member_by_token(token)
    if not m:
        raise HTTPException(404, "邀约链接无效")
    mid = m["id"]

    if long:
        timeout = CFG["limits"].get("long_poll_timeout", 120)
        interval = 0.5
        waited = 0.0
        while waited < timeout:
            info = _hr.pending_task(mid)
            if info:
                return {"waiting": True, "task": info["task"],
                        "reply_token": info["reply_token"],
                        "member": _member_out(m)}
            await asyncio.sleep(interval)
            waited += interval
        return {"waiting": False, "task": None, "reply_token": None,
                "member": _member_out(m)}

    info = _hr.pending_task(mid)
    return {"waiting": info is not None, "task": info["task"] if info else None,
            "reply_token": info["reply_token"] if info else None,
            "member": _member_out(m)}


class BridgeSubmitIn(BaseModel):
    content: str
    reply_token: str | None = None


@app.post("/api/bridge/{token}/submit")
async def bridge_submit(token: str, body: BridgeSubmitIn):
    """第三方 Agent 提交任务结果。

    必须携带 poll 返回的 reply_token，防止串任务和重复提交。
    """
    m = db.get_member_by_token(token)
    if not m:
        raise HTTPException(404, "邀约链接无效")
    if not body.content.strip():
        raise HTTPException(400, "回复不能为空")
    ok, reason = _hr.submit_reply(m["id"], body.content.strip(), body.reply_token)
    if not ok:
        msgs = {
            "no_pending": "当前没有等待回复的任务",
            "already_done": "任务已提交，请勿重复发送",
            "token_mismatch": "reply_token 不匹配，任务可能已过期或被替换，请重新 poll 获取最新任务",
            "cancelled": "任务已被叫停",
            "stale": "任务已超时过期，请重新 poll 获取新任务",
        }
        raise HTTPException(400, msgs.get(reason, f"提交失败: {reason}"))
    return {"ok": True}


@app.post("/api/bridge/{token}/heartbeat")
async def bridge_heartbeat(token: str):
    """第三方 Agent 心跳：保持 relay 任务活跃，防止被 stale 清理。"""
    m = db.get_member_by_token(token)
    if not m:
        raise HTTPException(404, "邀约链接无效")
    if not _hr.heartbeat(m["id"]):
        raise HTTPException(400, "当前没有活跃任务")
    return {"ok": True}


@app.get("/api/bridge/{token}/status")
def bridge_status(token: str):
    """查询当前 relay 任务状态：pending/active/done/cancelled/stale/None。"""
    m = db.get_member_by_token(token)
    if not m:
        raise HTTPException(404, "邀约链接无效")
    return {"status": _hr.task_status(m["id"]),
            "callback_url": m.get("callback_url")}


# ---------- Bridge Webhook 回调管理（推模式，免轮询） ----------
class CallbackIn(BaseModel):
    callback_url: str


@app.post("/api/bridge/{token}/callback")
async def bridge_set_callback(token: str, body: CallbackIn):
    """Agent 注册/更新 Webhook 回调地址。

    注册后任务入队时服务端主动 POST 推送 task.new 事件（含任务全文与 reply_token），
    Agent 无需再阻塞轮询；取消时推送 task.cancelled。注册即回推一次当前挂起任务（如有）。
    """
    m = db.get_member_by_token(token)
    if not m:
        raise HTTPException(404, "邀约链接无效")
    url = body.callback_url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "callback_url 必须是 http(s) 地址")
    db.set_member_callback(m["id"], url)
    # 注册瞬间可能已有挂起任务：立即补推一次，避免错过
    info = _hr.pending_task(m["id"])
    if info:
        state = {"task": info["task"], "reply_token": info["reply_token"]}
        asyncio.create_task(_hr.notify_task({**m, "callback_url": url}, state))
    return {"ok": True, "callback_url": url}


@app.get("/api/bridge/{token}/callback")
def bridge_get_callback(token: str):
    """查询当前已注册的回调地址。"""
    m = db.get_member_by_token(token)
    if not m:
        raise HTTPException(404, "邀约链接无效")
    return {"callback_url": m.get("callback_url")}


@app.delete("/api/bridge/{token}/callback")
def bridge_del_callback(token: str):
    """注销回调地址，退回到轮询模式。"""
    m = db.get_member_by_token(token)
    if not m:
        raise HTTPException(404, "邀约链接无效")
    db.set_member_callback(m["id"], None)
    return {"ok": True}


@app.post("/api/bridge/{token}/callback/test")
async def bridge_test_callback(token: str):
    """向已注册的回调地址发送 ping 测试事件，验证连通性。"""
    m = db.get_member_by_token(token)
    if not m:
        raise HTTPException(404, "邀约链接无效")
    if not m.get("callback_url"):
        raise HTTPException(400, "尚未注册回调地址")
    ok = await _hr.ping_callback(m)
    return {"ok": ok, "callback_url": m["callback_url"],
            "msg": "测试事件已送达" if ok else "推送失败：地址不可达或返回错误（已重试3次）"}


# ---------- DSH 桥回执 ----------
class DshCallbackIn(BaseModel):
    event: str | None = None
    task_id: str | None = None
    reply_token: str | None = None
    status: str | None = None
    result: str | None = None
    error: str | None = None


@app.post("/api/dsh/callback")
async def dsh_callback(body: DshCallbackIn):
    """DSH Agent 任务完成回执(task.done):唤醒挂起的 dsh 适配器,回复写回群聊。"""
    if body.event == "ping":
        return {"ok": True, "message": "pong"}
    ok, reason = _dsh.submit_callback(body.reply_token, body.status,
                                      body.result, body.error)
    if not ok:
        raise HTTPException(400, reason)
    return {"ok": True}


# ---------- 静态页 ----------
app.mount("/", StaticFiles(directory=os.path.join(BASE_DIR, "static"), html=True),
          name="static")
