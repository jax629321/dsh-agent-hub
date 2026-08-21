#!/usr/bin/env python3
"""智能体协作台 · 内置 TRD 后端启动器(混合自动模式)

由 DSH host 插件在探测到后端未就绪时拉起;也可手动运行:
    python backend/start.py

流程:
  1. 探测 TRD_HOST:TRD_PORT —— 已有服务则直接退出(复用,不重复启动)。
  2. 无服务 → 自动创建 .venv 并 pip install -r requirements.txt(仅首次)。
  3. 以 uvicorn 常驻启动 server.app。
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
else:
    VENV_PY = os.path.join(VENV, "bin", "python")


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
    subprocess.check_call([sys.executable, "-m", "venv", VENV])
    print("== 安装依赖(首次) ==", flush=True)
    subprocess.check_call(
        [VENV_PY, "-m", "pip", "install", "--disable-pip-version-check", "-q",
         "-r", os.path.join(HERE, "requirements.txt")])


def main() -> int:
    if probe():
        print(f"TRD 后端已在 {HOST}:{PORT} 运行,无需启动。", flush=True)
        return 0
    ensure_deps()
    print(f"== 启动 TRD 后端 {HOST}:{PORT} ==", flush=True)
    # 后台常驻启动 uvicorn,启动器干净退出;uvicorn 随 DSH 进程树结束,下次 apply 自愈拉起
    flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    subprocess.Popen(
        [VENV_PY, "-m", "uvicorn", "server.app:app", "--host", HOST, "--port", str(PORT)],
        cwd=HERE, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=flags)
    print("后端已在后台启动。", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
