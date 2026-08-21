"""SQLite 存储层：房间/成员/消息/任务/审批/文件。标准库 sqlite3，零 ORM 依赖。"""
import json
import os
import sqlite3
import threading
import time
import uuid

_LOCK = threading.Lock()
_CONN = None


def init(data_dir: str):
    """初始化数据库连接并建表。"""
    global _CONN
    os.makedirs(data_dir, exist_ok=True)
    os.makedirs(os.path.join(data_dir, "files"), exist_ok=True)
    _CONN = sqlite3.connect(os.path.join(data_dir, "trd.db"), check_same_thread=False)
    _CONN.row_factory = sqlite3.Row
    with _LOCK, _CONN:
        _CONN.executescript("""
        CREATE TABLE IF NOT EXISTS rooms(
            id TEXT PRIMARY KEY, name TEXT NOT NULL,
            auto_approve INTEGER DEFAULT 0,
            orchestrator_member_id TEXT, created_at REAL);
        CREATE TABLE IF NOT EXISTS members(
            id TEXT PRIMARY KEY, room_id TEXT NOT NULL, name TEXT NOT NULL,
            type TEXT NOT NULL, config TEXT DEFAULT '{}', invite_token TEXT,
            callback_url TEXT, created_at REAL, UNIQUE(room_id, name));
        CREATE TABLE IF NOT EXISTS messages(
            id TEXT PRIMARY KEY, room_id TEXT NOT NULL, sender_type TEXT NOT NULL,
            sender_name TEXT NOT NULL, member_id TEXT, content TEXT,
            file_ids TEXT DEFAULT '[]', status TEXT DEFAULT 'done',
            task_id TEXT, created_at REAL);
        CREATE TABLE IF NOT EXISTS tasks(
            id TEXT PRIMARY KEY, room_id TEXT NOT NULL, requirement TEXT,
            status TEXT DEFAULT 'running', rounds INTEGER DEFAULT 0, created_at REAL);
        CREATE TABLE IF NOT EXISTS approvals(
            id TEXT PRIMARY KEY, task_id TEXT NOT NULL, room_id TEXT NOT NULL,
            round INTEGER, plan_json TEXT, status TEXT DEFAULT 'pending', created_at REAL);
        CREATE TABLE IF NOT EXISTS files(
            id TEXT PRIMARY KEY, room_id TEXT NOT NULL, filename TEXT,
            path TEXT, created_at REAL);
        """)
        _migrate()


def _migrate():
    """旧库结构迁移：rooms 补 orchestrator_member_id / deleted_at / memory 列；
    members 补 callback_url 列。"""
    cols = {r[1] for r in _CONN.execute("PRAGMA table_info(rooms)")}
    if "orchestrator_member_id" not in cols:
        _CONN.execute("ALTER TABLE rooms ADD COLUMN orchestrator_member_id TEXT")
    if "deleted_at" not in cols:
        _CONN.execute("ALTER TABLE rooms ADD COLUMN deleted_at REAL")
    if "memory" not in cols:
        _CONN.execute("ALTER TABLE rooms ADD COLUMN memory TEXT DEFAULT ''")
    mcols = {r[1] for r in _CONN.execute("PRAGMA table_info(members)")}
    if "callback_url" not in mcols:
        _CONN.execute("ALTER TABLE members ADD COLUMN callback_url TEXT")


def _uid() -> str:
    return uuid.uuid4().hex[:16]


def _rows(cur) -> list[dict]:
    return [dict(r) for r in cur.fetchall()]


def _one(cur) -> dict | None:
    r = cur.fetchone()
    return dict(r) if r else None


# ---------- 房间 ----------
def create_room(name: str, auto_approve: bool = False) -> dict:
    rid = _uid()
    with _LOCK, _CONN:
        _CONN.execute("INSERT INTO rooms(id,name,auto_approve,created_at) VALUES(?,?,?,?)",
                      (rid, name, int(auto_approve), time.time()))
    return get_room(rid)


def get_room(room_id: str) -> dict | None:
    with _LOCK:
        return _one(_CONN.execute("SELECT * FROM rooms WHERE id=?", (room_id,)))


def list_rooms() -> list[dict]:
    """主列表：只含未删除的群。"""
    with _LOCK:
        return _rows(_CONN.execute(
            "SELECT * FROM rooms WHERE deleted_at IS NULL ORDER BY created_at DESC"))


def list_archived_rooms() -> list[dict]:
    """历史归档：已删除的群，附成员数/消息数统计。"""
    with _LOCK:
        return _rows(_CONN.execute("""
            SELECT r.*,
                   (SELECT COUNT(*) FROM members m WHERE m.room_id=r.id) AS member_count,
                   (SELECT COUNT(*) FROM messages msg WHERE msg.room_id=r.id) AS message_count
            FROM rooms r WHERE r.deleted_at IS NOT NULL
            ORDER BY r.deleted_at DESC"""))


def soft_delete_room(room_id: str):
    with _LOCK, _CONN:
        _CONN.execute("UPDATE rooms SET deleted_at=? WHERE id=?", (time.time(), room_id))


def restore_room(room_id: str):
    with _LOCK, _CONN:
        _CONN.execute("UPDATE rooms SET deleted_at=NULL WHERE id=?", (room_id,))


def purge_room(room_id: str):
    """彻底删除：群及其成员/消息/任务/审批全量清除（附件文件保留在磁盘）。"""
    with _LOCK, _CONN:
        for table in ("members", "messages", "tasks", "approvals", "files"):
            _CONN.execute(f"DELETE FROM {table} WHERE room_id=?", (room_id,))
        _CONN.execute("DELETE FROM rooms WHERE id=?", (room_id,))


def set_memory(room_id: str, memory: str):
    with _LOCK, _CONN:
        _CONN.execute("UPDATE rooms SET memory=? WHERE id=?", (memory, room_id))


def set_auto_approve(room_id: str, flag: bool):
    with _LOCK, _CONN:
        _CONN.execute("UPDATE rooms SET auto_approve=? WHERE id=?", (int(flag), room_id))


def set_orchestrator(room_id: str, member_id: str | None):
    """指定/取消房间的统筹大脑成员。"""
    with _LOCK, _CONN:
        _CONN.execute("UPDATE rooms SET orchestrator_member_id=? WHERE id=?",
                      (member_id, room_id))


# ---------- 成员 ----------
def add_member(room_id: str, name: str, mtype: str, config: dict,
               invite_token: str | None = None) -> dict:
    mid = _uid()
    with _LOCK, _CONN:
        _CONN.execute(
            "INSERT INTO members(id,room_id,name,type,config,invite_token,created_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (mid, room_id, name, mtype, json.dumps(config, ensure_ascii=False),
             invite_token, time.time()))
    return get_member(mid)


def get_member(member_id: str) -> dict | None:
    with _LOCK:
        return _one(_CONN.execute("SELECT * FROM members WHERE id=?", (member_id,)))


def get_member_by_token(token: str) -> dict | None:
    with _LOCK:
        return _one(_CONN.execute("SELECT * FROM members WHERE invite_token=?", (token,)))


def list_members(room_id: str) -> list[dict]:
    with _LOCK:
        return _rows(_CONN.execute(
            "SELECT id,room_id,name,type,invite_token,callback_url,created_at"
            " FROM members WHERE room_id=?",
            (room_id,)))


def set_member_callback(member_id: str, callback_url: str | None):
    """注册/清除成员的 Webhook 回调地址。"""
    with _LOCK, _CONN:
        _CONN.execute("UPDATE members SET callback_url=? WHERE id=?",
                      (callback_url, member_id))


def get_member_config(member_id: str) -> dict:
    with _LOCK:
        r = _one(_CONN.execute("SELECT config FROM members WHERE id=?", (member_id,)))
    return json.loads(r["config"]) if r else {}


# ---------- 消息 ----------
def add_message(room_id: str, sender_type: str, sender_name: str, content: str,
                member_id: str | None = None, file_ids: list | None = None,
                status: str = "done", task_id: str | None = None) -> dict:
    mid = _uid()
    with _LOCK, _CONN:
        _CONN.execute("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)",
                      (mid, room_id, sender_type, sender_name, member_id, content,
                       json.dumps(file_ids or []), status, task_id, time.time()))
    with _LOCK:
        return _one(_CONN.execute("SELECT * FROM messages WHERE id=?", (mid,)))


def update_message_status(msg_id: str, status: str, content: str | None = None):
    with _LOCK, _CONN:
        if content is not None:
            _CONN.execute("UPDATE messages SET status=?, content=? WHERE id=?",
                          (status, content, msg_id))
        else:
            _CONN.execute("UPDATE messages SET status=? WHERE id=?", (status, msg_id))


def list_messages(room_id: str, limit: int = 200) -> list[dict]:
    with _LOCK:
        return _rows(_CONN.execute(
            "SELECT * FROM messages WHERE room_id=? ORDER BY created_at LIMIT ?",
            (room_id, limit)))


def tail_messages(room_id: str, n: int) -> list[dict]:
    with _LOCK:
        rows = _rows(_CONN.execute(
            "SELECT * FROM messages WHERE room_id=? ORDER BY created_at DESC LIMIT ?",
            (room_id, n)))
    return list(reversed(rows))


# ---------- 任务 ----------
def create_task(room_id: str, requirement: str) -> dict:
    tid = _uid()
    with _LOCK, _CONN:
        _CONN.execute(
            "INSERT INTO tasks(id,room_id,requirement,rounds,created_at) VALUES(?,?,?,0,?)",
            (tid, room_id, requirement, time.time()))
    return get_task(tid)


def get_task(task_id: str) -> dict | None:
    with _LOCK:
        return _one(_CONN.execute("SELECT * FROM tasks WHERE id=?", (task_id,)))


def update_task(task_id: str, status: str | None = None, rounds: int | None = None):
    with _LOCK, _CONN:
        if status is not None:
            _CONN.execute("UPDATE tasks SET status=? WHERE id=?", (status, task_id))
        if rounds is not None:
            _CONN.execute("UPDATE tasks SET rounds=? WHERE id=?", (rounds, task_id))


def running_task(room_id: str) -> dict | None:
    with _LOCK:
        return _one(_CONN.execute(
            "SELECT * FROM tasks WHERE room_id=? AND status='running' ORDER BY created_at DESC",
            (room_id,)))


# ---------- 审批 ----------
def create_approval(task_id: str, room_id: str, round_no: int, plan: dict) -> dict:
    aid = _uid()
    with _LOCK, _CONN:
        _CONN.execute("INSERT INTO approvals VALUES(?,?,?,?,?,?,?)",
                      (aid, task_id, room_id, round_no,
                       json.dumps(plan, ensure_ascii=False), "pending", time.time()))
    with _LOCK:
        return _one(_CONN.execute("SELECT * FROM approvals WHERE id=?", (aid,)))


def get_approval(aid: str) -> dict | None:
    with _LOCK:
        return _one(_CONN.execute("SELECT * FROM approvals WHERE id=?", (aid,)))


def set_approval_status(aid: str, status: str):
    with _LOCK, _CONN:
        _CONN.execute("UPDATE approvals SET status=? WHERE id=?", (status, aid))


def pending_approvals(room_id: str) -> list[dict]:
    with _LOCK:
        return _rows(_CONN.execute(
            "SELECT * FROM approvals WHERE room_id=? AND status='pending'", (room_id,)))


# ---------- 文件 ----------
def add_file(room_id: str, filename: str, path: str) -> dict:
    fid = _uid()
    with _LOCK, _CONN:
        _CONN.execute("INSERT INTO files VALUES(?,?,?,?,?)", (fid, room_id, filename, path, time.time()))
    with _LOCK:
        return _one(_CONN.execute("SELECT * FROM files WHERE id=?", (fid,)))


def get_file(file_id: str) -> dict | None:
    with _LOCK:
        return _one(_CONN.execute("SELECT * FROM files WHERE id=?", (file_id,)))
