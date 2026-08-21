"""适配器抽象：统一 Agent 调用接口。"""
from abc import ABC, abstractmethod


class BaseAdapter(ABC):
    """所有 Agent 适配器的统一接口。

    chat(messages, files) -> str
    messages: [{"role": "user"|"assistant", "content": str}, ...] 对话上下文
    files: [{"filename": str, "text": str}, ...] 文本类附件内容
    返回 Agent 的文本回复；失败时抛出异常，由路由层捕获并落库为失败消息。
    """

    def __init__(self, member: dict, config: dict):
        self.member = member
        self.config = config

    @abstractmethod
    async def chat(self, messages: list[dict], files: list[dict] | None = None) -> str:
        ...


def files_to_text(files: list[dict] | None) -> str:
    """把附件内容拼成提示词文本段。"""
    if not files:
        return ""
    parts = ["\n\n【附件】"]
    for f in files:
        parts.append(f"--- {f['filename']} ---\n{f.get('text', '')}")
    return "\n".join(parts)
