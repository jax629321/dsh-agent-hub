"""全局协作章程加载器:项目根 charter.txt 作为全局协作规范的唯一事实源。

- 大脑每轮决策(config 回退大脑)与成员每次派单都会前置注入本章程(见 orchestrator/router)。
- 带 mtime 缓存:运行中直接编辑 charter.txt 即可热生效,无需重启 TRD。
"""
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_PATH = os.path.join(BASE_DIR, "charter.txt")
_cache = {"text": "", "mtime": None}


def get_charter() -> str:
    """返回章程全文;文件缺失/不可读时返回空串(不注入)。"""
    try:
        mtime = os.path.getmtime(_PATH)
    except OSError:
        return ""
    if _cache["text"] and _cache["mtime"] == mtime:
        return _cache["text"]
    try:
        with open(_PATH, "r", encoding="utf-8") as f:
            text = f.read().strip()
    except OSError:
        return ""
    _cache["text"] = text
    _cache["mtime"] = mtime
    return text


def set_charter(text: str) -> None:
    """整体覆盖章程(供控制台编辑)。"""
    with open(_PATH, "w", encoding="utf-8") as f:
        f.write(text.strip() + "\n")
    _cache["text"] = text.strip()
    try:
        _cache["mtime"] = os.path.getmtime(_PATH)
    except OSError:
        _cache["mtime"] = None
