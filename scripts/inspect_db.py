"""快速查看 backend/biling.db 各表最新记录：blueprints / agent_tasks / novels / author_confirms。

用法：在项目根目录执行 python scripts/inspect_db.py（内部以相对路径 backend/biling.db 连接）
分别打印四张表按创建时间倒序的最新若干行。
"""
import sqlite3

conn = sqlite3.connect("backend/biling.db")
cur = conn.cursor()

print("=== blueprints ===")
cur.execute(
    "SELECT id, novel_id, version, status, created_at FROM blueprints ORDER BY created_at DESC LIMIT 10"
)
for r in cur.fetchall():
    print(r)

print("=== agent_tasks (blueprint related) ===")
cur.execute(
    "SELECT id, novel_id, agent, status, msg, error, created_at FROM agent_tasks WHERE agent LIKE '%blueprint%' ORDER BY created_at DESC LIMIT 10"
)
for r in cur.fetchall():
    print(r)

print("=== novels ===")
cur.execute("SELECT id, title, created_at FROM novels ORDER BY created_at DESC LIMIT 10")
for r in cur.fetchall():
    print(r)

print("=== author_confirms ===")
cur.execute(
    "SELECT id, novel_id, agent, confirm_key, status, answer, substr(question,1,60) FROM author_confirms ORDER BY created_at DESC LIMIT 15"
)
for r in cur.fetchall():
    print(r)
conn.close()
