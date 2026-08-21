"""扣子(Coze) Bot API 适配器：v3 会话接口，创建会话后轮询结果。"""
import asyncio

import httpx

from .base import BaseAdapter, files_to_text


class CozeAdapter(BaseAdapter):
    API = "https://api.coze.cn/v3"

    async def chat(self, messages: list[dict], files: list[dict] | None = None) -> str:
        token = self.config["pat_token"]
        bot_id = self.config["bot_id"]
        headers = {"Authorization": f"Bearer {token}"}
        # Coze v3 只需发送用户消息；取最后一条用户输入，附加上附件
        query = messages[-1]["content"] + files_to_text(files)
        body = {
            "bot_id": bot_id,
            "user_id": "trd_user",
            "stream": False,
            "auto_save_history": True,
            "additional_messages": [
                {"role": "user", "content": query, "content_type": "text"}
            ],
        }
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(f"{self.API}/chat", json=body, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            if data.get("code") != 0:
                raise RuntimeError(f"Coze 创建会话失败: {data.get('msg')}")
            chat_id = data["data"]["id"]
            conv_id = data["data"]["conversation_id"]
            # 轮询会话状态直至完成
            for _ in range(60):
                await asyncio.sleep(2)
                r = await client.get(
                    f"{self.API}/chat/retrieve",
                    params={"chat_id": chat_id, "conversation_id": conv_id},
                    headers=headers)
                r.raise_for_status()
                st = r.json()["data"]["status"]
                if st == "completed":
                    break
                if st in ("failed", "requires_action"):
                    raise RuntimeError(f"Coze 会话状态异常: {st}")
            else:
                raise TimeoutError("Coze 会话轮询超时")
            # 取回答消息
            r = await client.get(
                f"{self.API}/chat/message/list",
                params={"chat_id": chat_id, "conversation_id": conv_id},
                headers=headers)
            r.raise_for_status()
            for msg in r.json().get("data", []):
                if msg.get("type") == "answer" and msg.get("role") == "assistant":
                    return msg.get("content", "")
        raise RuntimeError("Coze 未返回答案")
