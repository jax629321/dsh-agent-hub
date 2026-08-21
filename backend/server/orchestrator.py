"""统筹大脑（主 Agent）编排状态机：
需求 → 主Agent输出JSON计划 → 生成审批 → 人类确认 → 执行分发 → 收齐结果 → 主Agent评估 → 循环/DONE。
熔断：最大轮次、单轮超时、人类叫停。
"""
import asyncio
import json
import re

import httpx

from . import charter, db, router

_CFG: dict = {}          # config.yaml 内容（orchestrator/limits 节）
_STOPPED: set[str] = set()   # 被人类叫停的 task_id


def init(cfg: dict):
    global _CFG
    _CFG = cfg


def stop_task(task_id: str):
    """人类叫停：置标志位并更新状态，循环在下一检查点退出。"""
    _STOPPED.add(task_id)
    db.update_task(task_id, status="stopped")


_SYSTEM = """你是「统筹大脑」，一个多 Agent 协作群的指挥者。群里除你和人类外有以下成员：
{roster}

你的工作方式：
1. 理解人类的需求，拆解为可执行的子任务，用 @成员名 分派给最合适的成员。
2. 成员执行后结果会回流到群消息里，你阅读后评估质量，决定下一步：继续分派、打回重做、或宣布完成。
3. 每轮你必须只输出一个 JSON 对象（不要输出任何其他文字），格式：
{{
  "plan": "本轮思路简述",
  "dispatch": [{{"member": "成员显示名", "task": "具体任务指令"}}],
  "status": "dispatching 或 done",
  "final": "status=done 时给人类的最终交付总结",
  "memory": "对群长期记忆的更新：提炼截至目前的关键事实、结论、交付物要点，供后续轮次和任务复用；无新沉淀时原样返回旧记忆"
}}
规则：dispatch 里的 member 必须严格等于上面的成员显示名；没有可分派的任务时 status=done；
打回重做也算 dispatching；每轮尽量并行分派互不依赖的任务；
memory 会持久保存并在此后每轮注入给你，请只保留真正重要的信息，控制在 500 字内。"""


async def _call_brain(room_id: str, task: dict, round_no: int) -> dict:
    """调用主 Agent，返回解析后的 JSON 计划。

    优先使用房间指定的「大脑成员」（API/扣子/人工中继均可）；
    未指定时回退到 config.yaml 的 OpenAI 兼容配置。
    """
    tail_n = _CFG["limits"]["context_tail"]
    members = db.list_members(room_id)
    roster = "\n".join(f"- {m['name']}（{m['type']}）" for m in members) or "（暂无成员）"
    tail = db.tail_messages(room_id, tail_n)
    transcript = "\n".join(f"{m['sender_name']}: {(m['content'] or '')[:600]}" for m in tail)
    system = _SYSTEM.format(roster=roster)
    room = db.get_room(room_id)
    memory = (room.get("memory") or "").strip() if room else ""
    user = (f"【人类需求】{task['requirement']}\n\n【当前轮次】第 {round_no} 轮\n\n"
            f"【群记忆】\n{memory or '（暂无）'}\n\n"
            f"【群聊记录】\n{transcript}\n\n请输出本轮 JSON 决策。")

    brain_member = None
    if room and room.get("orchestrator_member_id"):
        brain_member = db.get_member(room["orchestrator_member_id"])
    if brain_member:
        return await _call_member_brain(room_id, task, brain_member, system, user)
    return await _call_config_brain(system, user)


async def _call_member_brain(room_id: str, task: dict, member: dict,
                             system: str, user: str) -> dict:
    """通过成员适配器调用大脑：人工中继型大脑由此获得邀约入群能力。

    先在消息流落一条 @大脑 的决策请求（中继页由此可见任务），
    再走统一投递等待回复，最后从回复文本解析 JSON 计划。
    """
    timeout = _CFG["limits"]["round_timeout_sec"]
    prompt = f"{system}\n\n{user}"
    req_msg = db.add_message(room_id, "system", "系统",
                             f"@{member['name']} 请作为统筹大脑输出第 {task['rounds']+1} 轮 JSON 决策",
                             task_id=task["id"])
    await router.broadcast(room_id, {"kind": "message", "message": req_msg})
    reply_msg = await router.call_member(member, prompt, room_id,
                                         timeout=timeout, task_id=task["id"])
    if reply_msg["status"] == "failed":
        raise RuntimeError(f"大脑成员调用失败: {reply_msg['content']}")
    return _parse_plan(reply_msg["content"] or "")


async def _call_config_brain(system: str, user: str) -> dict:
    """回退路径：直接调用 config.yaml 里的 OpenAI 兼容模型。"""
    charter_text = charter.get_charter()
    if charter_text:
        system = f"【全局协作章程】\n{charter_text}\n\n{system}"
    oc = _CFG["orchestrator"]
    url = oc["base_url"].rstrip("/") + "/v1/chat/completions"
    payload = {
        "model": oc["model"],
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "stream": False,
    }
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(url, json=payload,
                                 headers={"Authorization": f"Bearer {oc['api_key']}"})
        resp.raise_for_status()
        text = resp.json()["choices"][0]["message"]["content"]
    return _parse_plan(text)


def _parse_plan(text: str) -> dict:
    """从模型输出提取 JSON 计划；提取失败时降级为直接交付。"""
    m = re.search(r"\{.*\}", text, re.S)
    if m:
        try:
            plan = json.loads(m.group(0))
            plan.setdefault("plan", "")
            plan.setdefault("dispatch", [])
            plan.setdefault("status", "dispatching")
            return plan
        except json.JSONDecodeError:
            pass
    # 主 Agent 没按约定输出时，把原文作为最终交付，避免死循环
    return {"plan": "主Agent未按格式输出，直接交付原文", "dispatch": [],
            "status": "done", "final": text}


async def _sys_msg(room_id: str, content: str, task_id: str | None = None):
    msg = db.add_message(room_id, "system", "统筹大脑", content, task_id=task_id)
    await router.broadcast(room_id, {"kind": "message", "message": msg})


async def start_task(room_id: str, requirement: str):
    """入口：建任务并启动编排循环（后台协程）。"""
    task = db.create_task(room_id, requirement)
    await _sys_msg(room_id, f"已接收需求，开始拆解：{requirement}", task["id"])
    asyncio.create_task(_loop(task["id"], room_id))
    return task


async def _loop(task_id: str, room_id: str):
    """状态机主循环。"""
    max_rounds = _CFG["limits"]["max_rounds"]
    try:
        while True:
            task = db.get_task(task_id)
            if not task or task["status"] != "running" or task_id in _STOPPED:
                return
            round_no = task["rounds"] + 1
            if round_no > max_rounds:
                db.update_task(task_id, status="stopped")
                await _sys_msg(room_id, f"已达最大轮次 {max_rounds}，任务熔断停止。", task_id)
                return
            db.update_task(task_id, rounds=round_no)
            try:
                plan = await _call_brain(room_id, task, round_no)
            except Exception as e:
                db.update_task(task_id, status="failed")
                await _sys_msg(room_id, f"统筹大脑调用失败，任务终止：{type(e).__name__}: {e}", task_id)
                return
            # 大脑沉淀的长期记忆入库，后续轮次/任务注入
            if isinstance(plan.get("memory"), str) and plan["memory"].strip():
                db.set_memory(room_id, plan["memory"].strip())
            if plan.get("status") == "done":
                db.update_task(task_id, status="done")
                await _sys_msg(room_id, f"✅ 任务完成\n{plan.get('final', '')}", task_id)
                return
            if not plan.get("dispatch"):
                await _sys_msg(room_id, "主Agent本轮未分派任何任务，等待人类指示。", task_id)
                return
            # 审批关卡
            room = db.get_room(room_id)
            approval = db.create_approval(task_id, room_id, round_no, plan)
            if room and room["auto_approve"]:
                await _sys_msg(room_id, f"第 {round_no} 轮计划（自动批准）：{plan.get('plan', '')}", task_id)
                await _execute(room_id, task_id, plan)
            else:
                await router.broadcast(room_id, {"kind": "approval", "approval": approval})
                await _sys_msg(room_id, f"第 {round_no} 轮计划待审批：{plan.get('plan', '')}", task_id)
                return  # 挂起，等人类在界面确认后由 approve() 继续
    finally:
        _STOPPED.discard(task_id)


async def approve(approval_id: str, modified_plan: dict | None = None):
    """人类确认（或修改后确认）一轮计划。

    分发执行可能长时间挂起（如人工中继成员），故放入后台协程，
    接口立即返回，不阻塞调用方。
    """
    ap = db.get_approval(approval_id)
    if not ap or ap["status"] != "pending":
        return
    db.set_approval_status(approval_id, "approved")
    plan = modified_plan or json.loads(ap["plan_json"])
    asyncio.create_task(_run_round(ap["room_id"], ap["task_id"], plan))


async def _run_round(room_id: str, task_id: str, plan: dict):
    """后台执行一轮分发，收齐后继续编排循环。"""
    await _execute(room_id, task_id, plan)
    await _loop(task_id, room_id)


async def reject(approval_id: str, reason: str = ""):
    """人类否决一轮计划：任务停止，主 Agent 不再继续。"""
    ap = db.get_approval(approval_id)
    if not ap or ap["status"] != "pending":
        return
    db.set_approval_status(approval_id, "rejected")
    db.update_task(ap["task_id"], status="stopped")
    await _sys_msg(ap["room_id"], f"计划被人类否决，任务停止。{reason}", ap["task_id"])


async def _execute(room_id: str, task_id: str, plan: dict):
    """执行一轮分发：并行调用成员，收齐结果（成员回复已由路由写回消息流）。"""
    timeout = _CFG["limits"]["round_timeout_sec"]
    members = {m["name"]: m for m in db.list_members(room_id)}
    jobs = []
    for item in plan.get("dispatch", []):
        m = members.get(item.get("member"))
        if not m:
            await _sys_msg(room_id, f"成员「{item.get('member')}」不存在，跳过。", task_id)
            continue
        jobs.append(router.call_member(m, item.get("task", ""), room_id,
                                       timeout=timeout, task_id=task_id))
    if jobs:
        await asyncio.gather(*jobs, return_exceptions=True)
