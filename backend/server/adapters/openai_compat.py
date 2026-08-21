"""OpenAI 兼容协议适配器：覆盖 DeepSeek/通义/Kimi/GPT/Claude 等绝大多数 API 型 Agent。"""
import httpx

from .base import BaseAdapter, files_to_text


class OpenAICompatAdapter(BaseAdapter):
    async def chat(self, messages: list[dict], files: list[dict] | None = None) -> str:
        base = self.config["base_url"].rstrip("/")
        url = base if base.endswith("/chat/completions") else base + "/v1/chat/completions"
        msgs = list(messages)
        if files:
            # 附件内容拼到最后一条用户消息上
            msgs[-1] = {**msgs[-1], "content": msgs[-1]["content"] + files_to_text(files)}
        payload = {"model": self.config["model"], "messages": msgs, "stream": False}
        headers = {"Authorization": f"Bearer {self.config['api_key']}"}
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
        return data["choices"][0]["message"]["content"]
