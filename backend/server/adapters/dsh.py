"""DSH 桥适配器:把任务派发给 DeepSeek Harness 内的「AI会议室 Agent 桥」插件端点。

派发流程:
  1. POST {base_url}/trd-agent/tasks(带 X-TRD-Token 与 callback_url,
     callback_url 指向本 TRD 服务的 /api/dsh/callback,reply_token 随机生成)
  2. 等待回执(双通道,任一先到即可):
     - 回推通道:DSH 完成后 POST task.done 到 callback → submit_callback 唤醒挂起任务
     - 轮询兜底:每 5s GET /trd-agent/tasks/{id},回推丢失也能拿到结果
  3. 返回结果文本;失败/超时抛异常,由路由层落为失败消息

配置(config 字典,由成员创建时写入):
  base_url   DSH 端点地址,默认 http://127.0.0.1:3080
  token      DSH Agent 的 X-TRD-Token(面板/trd_card 获取)
  self_base  本 TRD 服务自身地址,用于构造 callback_url(创建成员时自动填充)
  timeout_sec 任务超时秒数,默认 600,会透传给 DSH 插件
"""
import asyncio
import secrets
import time

import httpx

from .base import BaseAdapter, files_to_text

# 挂起任务注册表:reply_token -> 状态(done/failed 由回调或轮询写入,cancelled 由叫停写入)
_PENDING: dict[str, dict] = {}


class DshAdapter(BaseAdapter):
    async def chat(self, messages: list[dict], files: list[dict] | None = None) -> str:
        # endpoint 可为完整端点(如 http://127.0.0.1:3080/trd-agent/4b91ab4d,多会话成员),
        # 兼容旧配置 base_url(=http://127.0.0.1:3080,则自动补 /trd-agent)
        raw_ep = str(self.config.get("endpoint") or self.config.get("base_url") or "").strip().rstrip("/")
        if not raw_ep:
            raw_ep = "http://127.0.0.1:3080/trd-agent"
        endpoint = raw_ep if raw_ep.endswith(("/trd-agent", "/tasks")) or "/trd-agent/" in raw_ep \
            else raw_ep + "/trd-agent"
        endpoint = endpoint.rstrip("/")
        token = str(self.config.get("token") or "")
        if not token:
            raise RuntimeError("DSH 成员缺少 token,请移除后重新添加并填写 DSH Token")
        timeout_sec = int(self.config.get("timeout_sec") or 600)
        task_text = messages[-1]["content"] if messages else ""
        if files:
            task_text += files_to_text(files)
        if not task_text.strip():
            raise RuntimeError("任务内容为空")

        reply_token = secrets.token_hex(16)
        state = {
            "event": asyncio.Event(),
            "task_id": None,
            "status": "pending",   # pending → done / failed / cancelled
            "result": None,
            "error": None,
            "room_id": self.member.get("room_id"),
            "created_at": time.time(),
        }
        _PENDING[reply_token] = state

        self_base = str(self.config.get("self_base") or "").strip().rstrip("/")
        callback_url = self_base + "/api/dsh/callback" if self_base else ""

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                r = await client.post(
                    f"{endpoint}/tasks",
                    headers={"X-TRD-Token": token},
                    json={
                        "task": task_text,
                        "from": f"trd-room:{str(state['room_id'] or '')[:8]}",
                        "reply_token": reply_token,
                        "callback_url": callback_url,
                        "timeout_sec": timeout_sec,
                    },
                )
                r.raise_for_status()
                state["task_id"] = r.json().get("id")

            # 等待回执:回调事件可即时唤醒,否则每 5s 轮询一次兜底
            deadline = time.time() + timeout_sec + 60
            while time.time() < deadline:
                if state["status"] != "pending":
                    break
                try:
                    await asyncio.wait_for(state["event"].wait(), timeout=5)
                except asyncio.TimeoutError:
                    pass
                if state["status"] != "pending" or not state["task_id"]:
                    continue
                try:
                    async with httpx.AsyncClient(timeout=15) as client:
                        pr = await client.get(
                            f"{endpoint}/tasks/{state['task_id']}",
                            headers={"X-TRD-Token": token})
                        pr.raise_for_status()
                        pj = pr.json()
                        if pj.get("status") in ("done", "failed"):
                            state["status"] = pj["status"]
                            state["result"] = pj.get("result")
                            state["error"] = pj.get("error")
                except Exception:
                    pass  # 单次轮询失败忽略,继续等回推/下次轮询

            if state["status"] == "done" and state["result"]:
                return str(state["result"])
            if state["status"] == "cancelled":
                raise RuntimeError("DSH 任务被叫停")
            if state["status"] == "failed":
                raise RuntimeError(f"DSH 任务执行失败: {state['error'] or '未知原因'}")
            raise TimeoutError(
                f"DSH 任务超时({timeout_sec}s)未返回结果;任务可能仍在 DSH 侧执行,"
                f"可打开 DSH 面板查看任务队列")
        finally:
            _PENDING.pop(reply_token, None)


def submit_callback(reply_token: str | None, status: str | None,
                    result: str | None, error: str | None) -> tuple[bool, str]:
    """DSH 回推的 task.done 事件落库并唤醒挂起的 chat()。"""
    state = _PENDING.get(reply_token)
    if not state:
        return False, "no_pending"
    if state["status"] in ("done", "failed", "cancelled"):
        return False, "already_done"
    state["status"] = status if status in ("done", "failed") else "done"
    state["result"] = result
    state["error"] = error
    state["event"].set()
    return True, ""


def cancel_room(room_id: str):
    """叫停某房间全部挂起的 DSH 任务(任务在 DSH 侧会由超时/子Agent取消兜底)。"""
    for st in _PENDING.values():
        if st["room_id"] != room_id or st["status"] != "pending":
            continue
        st["status"] = "cancelled"
        st["error"] = "任务被人类叫停"
        st["event"].set()
