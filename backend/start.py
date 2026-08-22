#!/usr/bin/env python3
"""智能体协作台 · 内置 TRD 后端启动器(混合自动模式)

由 DSH host 插件在探测到后端未就绪时拉起;也可手动运行:
    python backend/start.py

Windows 下本脚本会把自己立即重投为一个「无窗口后台进程」
(CREATE_NO_WINDOW|DETACHED_PROCESS),因此全程不会出现任何 CMD 窗口,
不需要用户手动开终端、也不需要保持终端不关闭。

流程:
  1. 无窗口自投(仅 Windows 首次执行)。
  2. 探测 TRD_HOST:TRD_PORT —— 已有服务则直接退出(复用,不重复启动)。
  3. 无服务 → 自动创建 .venv 并 pip install -r requirements.txt(仅首次)。
  4. 以 uvicorn 无窗口常驻启动 server.app。
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = os.environ.get("TRD_HOST", "127.0.0.1")
PORT = int(os.environ.get("TRD_PORT", "8000"))
VENV = os.path.join(HERE, ".venv")
if os.name == "nt":
    VENV_PY = os.path.join(VENV, "Scripts", "python.exe")
    # uvicorn 用 pythonw.exe(GUI 解释器)运行:物理上不可能创建控制台窗口,杜绝任何 CMD 弹出
    VENV_PYW = os.path.join(VENV, "Scripts", "pythonw.exe")
    _NO_WINDOW = subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS
else:
    VENV_PY = os.path.join(VENV, "bin", "python")
    VENV_PYW = VENV_PY
    _NO_WINDOW = 0


def detach_to_background() -> bool:
    """Windows 下立即把自己重投为无窗口后台进程,避免任何可见 CMD。

    若本身已是 pythonw.exe(无窗口解释器)运行,则无需再自投。
    """
    if os.name != "nt" or os.environ.get("DSH_BACKEND_SPAWNED"):
        return False
    if sys.executable.lower().endswith("pythonw.exe"):
        return False
    env = dict(os.environ)
    env["DSH_BACKEND_SPAWNED"] = "1"
    subprocess.Popen(
        [sys.executable] + sys.argv,
        cwd=HERE, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, creationflags=_NO_WINDOW, env=env)
    return True


def _nw() -> dict:
    """Windows 下返回隐藏控制台的子进程参数;其他平台为空。"""
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


def probe() -> bool:
    try:
        import socket
        with socket.create_connection((HOST, PORT), timeout=1.0):
            return True
    except OSError:
        return False


def ensure_deps() -> None:
    if os.path.exists(VENV_PY):
        return
    print("== 创建虚拟环境 ==", flush=True)
    subprocess.check_call([sys.executable, "-m", "venv", VENV], **_nw())
    print("== 安装依赖(首次) ==", flush=True)
    subprocess.check_call(
        [VENV_PY, "-m", "pip", "install", "--disable-pip-version-check", "-q",
         "-r", os.path.join(HERE, "requirements.txt")], **_nw())


def main() -> int:
    if detach_to_background():
        return 0
    if probe():
        print(f"TRD 后端已在 {HOST}:{PORT} 运行,无需启动。", flush=True)
        return 0
    ensure_deps()
    print(f"== 启动 TRD 后端 {HOST}:{PORT} ==", flush=True)
    # 无窗口常驻启动 uvicorn(pythonw + CREATE_NO_WINDOW,双重保证不弹窗);
    # uvicorn 随 DSH 进程树结束,下次 apply 自愈拉起
    subprocess.Popen(
        [VENV_PYW, "-m", "uvicorn", "server.app:app", "--host", HOST, "--port", str(PORT)],
        cwd=HERE, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=_NO_WINDOW)
    print("后端已在后台启动。", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
