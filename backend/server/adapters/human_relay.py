"""人工中继适配器：reply_token 幂等状态机 + 长轮询 + Webhook 推送。

状态流转：
  pending（已入队）→ active（被 poll 取走）→ done / cancelled / stale

Webhook：成员注册 callback_url 后，任务入队时主动 POST 推送 task.new 事件，
Agent 无需阻塞轮询即可收任务；轮询接口保留作为兜底/未注册回调时的兼容路径。
"""
import asyncio
import secrets
import time

import httpx

from .base import BaseAdapter

# 内存注册表：member_id -> {event, reply, task, reply_token, status, created_at, heartbeat_at}
_TASKS: dict[str, dict] = {}

_STALE_TIMEOUT = 1800  # 无心跳无提交的清理阈值（秒），由 config 覆盖


def init(stale_timeout: int):
    global _STALE_TIMEOUT
    _STALE_TIMEOUT = stale_timeout


class HumanRelayAdapter(BaseAdapter):
    async def chat(self, messages: list[dict], files: list[dict] | None = None) -> str:
        member_id = self.member["id"]
        task_text = messages[-1]["content"] if messages else ""
        reply_token = secrets.token_hex(16)
        state = {
            "event": asyncio.Event(),
            "reply": None,
            "task": task_text,
            "reply_token": reply_token,
            "status": "pending",  # pending → active → done / cancelled / stale
            "created_at": time.time(),
            "heartbeat_at": time.time(),
        }
        _TASKS[member_id] = state
        if self.member.get("callback_url"):
            # 已注册回调：异步推送 task.new，不阻塞入队
            asyncio.create_task(notify_task(self.member, state))
        try:
            # relay 无超时：只有明确取消/叫停或 stale 清理才终止
            await state["event"].wait()
            if state["status"] == "stale":
                raise RuntimeError("中继任务超时未响应，已过期清理")
            reply = state["reply"]
            if reply is None:
                raise RuntimeError("人工中继被取消")
            return reply
        finally:
            _TASKS.pop(member_id, None)


def _get_valid_state(member_id: str) -> dict | None:
    """返回有效的任务状态（排除已取消/已完成的残留）。"""
    state = _TASKS.get(member_id)
    if not state:
        return None
    if state["status"] in ("done", "cancelled"):
        return None
    return state


def pending_task(member_id: str) -> dict | None:
    """返回挂起中的任务信息，含 reply_token（供 bridge 拉模式接口）。

    首次 poll 时标记为 active（已被取走）。
    """
    state = _get_valid_state(member_id)
    if not state:
        return None
    if state["status"] == "pending":
        state["status"] = "active"
    return {
        "task": state["task"],
        "reply_token": state["reply_token"],
    }


def submit_reply(member_id: str, reply: str, reply_token: str | None = None) -> tuple[bool, str]:
    """中继页/Bridge 提交回复。返回 (是否成功, 失败原因)。

    - 无等待任务：返回 (False, "no_pending")
    - reply_token 不匹配：返回 (False, "token_mismatch")
    - 重复提交：返回 (False, "already_done")
    - 正常提交：唤醒挂起的 chat()，返回 (True, "")
    """
    state = _TASKS.get(member_id)
    if not state:
        return False, "no_pending"
    if state["status"] == "done":
        return False, "already_done"
    if state["status"] == "cancelled":
        return False, "cancelled"
    if state["status"] == "stale":
        return False, "stale"
    # reply_token 校验：如果任务有 token，提交必须携带且匹配
    if state["reply_token"] and reply_token != state["reply_token"]:
        return False, "token_mismatch"
    state["reply"] = reply
    state["status"] = "done"
    state["event"].set()
    return True, ""


def heartbeat(member_id: str) -> bool:
    """中继/Bridge 心跳：重置僵死计时，保持任务活跃。返回是否有等待中的任务。"""
    state = _get_valid_state(member_id)
    if not state:
        return False
    state["heartbeat_at"] = time.time()
    return True


def cancel(member_id: str) -> bool:
    """叫停任务：以 None 唤醒挂起的 chat()，使其抛出取消异常。"""
    state = _TASKS.get(member_id)
    if not state:
        return False
    if state["status"] in ("done", "cancelled"):
        return False
    state["reply"] = None
    state["status"] = "cancelled"
    state["event"].set()
    return True


def is_waiting(member_id: str) -> bool:
    return _get_valid_state(member_id) is not None


def task_status(member_id: str) -> str | None:
    """返回当前任务状态：pending / active / done / cancelled / stale / None。"""
    state = _TASKS.get(member_id)
    return state["status"] if state else None


# ---------- Webhook 推送 ----------
async def _post_callback(url: str, payload: dict) -> bool:
    """向 Agent 回调地址 POST 事件。指数退避重试 3 次（1s/2s/4s），失败静默不抛异常。"""
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.post(url, json=payload)
                if r.status_code < 400:
                    return True
        except Exception:
            pass
        if attempt < 2:
            await asyncio.sleep(2 ** attempt)
    return False


def _build_payload(event: str, member: dict, state: dict) -> dict:
    """构造回调事件载荷。路径为相对桥接服务源（Agent 注册回调时已知晓该源）。"""
    token = member.get("invite_token") or ""
    payload = {
        "event": event,  # task.new / task.cancelled
        "member": member.get("name", ""),
        "token": token,
        "poll_path": f"/api/bridge/{token}/poll",
        "submit_path": f"/api/bridge/{token}/submit",
        "heartbeat_path": f"/api/bridge/{token}/heartbeat",
        "issued_at": time.time(),
    }
    if event == "task.new":
        payload["task"] = state.get("task")
        payload["reply_token"] = state.get("reply_token")
    return payload


async def notify_task(member: dict, state: dict):
    """任务入队后推送给已注册回调的 Agent。"""
    url = member.get("callback_url")
    if url:
        await _post_callback(url, _build_payload("task.new", member, state))


async def notify_cancel(member: dict):
    """任务取消/清理时通知 Agent 停止执行。"""
    url = member.get("callback_url")
    if url:
        await _post_callback(url, _build_payload("task.cancelled", member, {}))


async def cancel_with_notify(member: dict) -> bool:
    """取消任务并在成功时异步通知 Agent（供 async 上下文调用）。"""
    ok = cancel(member["id"])
    if ok and member.get("callback_url"):
        asyncio.create_task(notify_cancel(member))
    return ok


async def ping_callback(member: dict) -> bool:
    """向已注册回调发送 ping 测试事件，返回是否送达。"""
    url = member.get("callback_url")
    if not url:
        return False
    return await _post_callback(url, _build_payload("ping", member, {}))


# ---------- 僵死任务清理 ----------
async def cleanup_stale():
    """后台协程：定期清理长时间无心跳无提交的 relay 任务。"""
    while True:
        await asyncio.sleep(60)
        now = time.time()
        stale_ids = []
        for mid, state in _TASKS.items():
            if state["status"] in ("done", "cancelled"):
                continue
            if now - state["heartbeat_at"] > _STALE_TIMEOUT:
                stale_ids.append(mid)
        for mid in stale_ids:
            state = _TASKS.get(mid)
            if state and state["status"] not in ("done", "cancelled"):
                state["reply"] = None
                state["status"] = "stale"
                state["event"].set()
