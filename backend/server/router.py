"""消息总线：@mention 解析、投递调度、回复写回、完成后广播。"""
import asyncio
import json
import re

from . import charter, db
from .adapters.base import BaseAdapter
from .adapters.coze import CozeAdapter
from .adapters.dsh import DshAdapter
from .adapters.human_relay import HumanRelayAdapter
from .adapters.openai_compat import OpenAICompatAdapter

# WebSocket 广播函数，由 app.py 注入：async fn(room_id, payload: dict)
_broadcaster = None


def set_broadcaster(fn):
    global _broadcaster
    _broadcaster = fn


async def broadcast(room_id: str, payload: dict):
    if _broadcaster:
        await _broadcaster(room_id, payload)


def build_adapter(member: dict) -> BaseAdapter:
    """按成员类型构造适配器。凭据从 DB config 读取，不外泄。
    trae/workbuddy 与 relay 共用人工中继传输（Bridge 轮询/推送）。"""
    config = db.get_member_config(member["id"])
    mtype = member["type"]
    if mtype == "openai":
        return OpenAICompatAdapter(member, config)
    if mtype == "coze":
        return CozeAdapter(member, config)
    if mtype == "dsh":
        return DshAdapter(member, config)
    if mtype in ("relay", "trae", "workbuddy"):
        return HumanRelayAdapter(member, config)
    raise ValueError(f"未知成员类型: {mtype}")


def parse_mentions(content: str, members: list[dict]) -> list[dict]:
    """解析 @显示名，返回被点到的成员列表（去重，保持顺序）。"""
    found, seen = [], set()
    for m in members:
        if m["name"] in seen:
            continue
        if re.search(r"@" + re.escape(m["name"]) + r"(?![\w一-鿿])", content):
            found.append(m)
            seen.add(m["name"])
    return found


def _read_file_texts(file_ids: list) -> list[dict]:
    """读取文本类附件内容（限长 4000 字符/个）。"""
    out = []
    for fid in file_ids or []:
        f = db.get_file(fid)
        if not f:
            continue
        try:
            with open(f["path"], "r", encoding="utf-8", errors="ignore") as fp:
                text = fp.read(4000)
            out.append({"filename": f["filename"], "text": text})
        except OSError:
            continue
    return out


def _build_context(room_id: str, task_text: str) -> list[dict]:
    """为成员构造对话上下文：全局章程 + 最近消息摘录 + 当前任务。"""
    tail = db.tail_messages(room_id, 15)
    lines = [f"{m['sender_name']}: {m['content'][:500]}" for m in tail if m["content"]]
    transcript = "\n".join(lines)
    charter_text = charter.get_charter()
    head = f"【全局协作章程】\n{charter_text}\n\n" if charter_text else ""
    user = f"{head}【群聊最近记录】\n{transcript}\n\n【现在交给你的任务】\n{task_text}"
    return [{"role": "user", "content": user}]


async def call_member(member: dict, task_text: str, room_id: str,
                      file_ids: list | None = None, timeout: int = 300,
                      task_id: str | None = None) -> dict:
    """调用一个成员并把回复写回消息流。返回回复消息记录。

    人工中继成员：先落一条 pending 占位消息（UI 标黄），回复到达后更新。
    API 型成员：失败/超时落一条 failed 消息，不抛出，保证总线不中断。
    """
    adapter = build_adapter(member)
    files = _read_file_texts(file_ids)
    if member["type"] in ("relay", "trae", "workbuddy"):
        placeholder_text = f"（等待 {member['name']} 中继回复…）"
    else:
        placeholder_text = "（思考中…）"
    placeholder = db.add_message(
        room_id, "agent", member["name"], placeholder_text,
        member_id=member["id"], status="pending", task_id=task_id)
    await broadcast(room_id, {"kind": "message", "message": placeholder})
    try:
        coro = adapter.chat(_build_context(room_id, task_text), files)
        if member["type"] in ("relay", "trae", "workbuddy", "dsh"):
            # relay/trae/workbuddy/dsh 适配器内部自管理等待与超时,不套外层 wait_for
            reply = await coro
        else:
            reply = await asyncio.wait_for(coro, timeout=timeout)
        db.update_message_status(placeholder["id"], "done", content=reply)
        msg = {**placeholder, "status": "done", "content": reply}
    except Exception as e:  # 超时/网络/API 错误统一落失败消息
        err = f"[调用失败] {type(e).__name__}: {e}"
        db.update_message_status(placeholder["id"], "failed", content=err)
        msg = {**placeholder, "status": "failed", "content": err}
    await broadcast(room_id, {"kind": "message", "message": msg,
                              "replace_id": placeholder["id"]})
    return msg


async def route_message(room_id: str, message: dict, timeout: int = 300):
    """人类消息落库后调用：解析 @ 并并行投递给被点成员。"""
    members = db.list_members(room_id)
    targets = parse_mentions(message["content"], members)
    if not targets:
        return
    file_ids = json.loads(message.get("file_ids") or "[]")
    await asyncio.gather(*[
        call_member(m, message["content"], room_id, file_ids, timeout)
        for m in targets
    ])
