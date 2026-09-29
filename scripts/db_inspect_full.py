"""全量检查 backend/biling.db：输出表结构与关键表数据。

用法：python scripts/db_inspect_full.py
输出 author_confirms 表结构，并打印 novels、agent_tasks（按创建时间倒序）、
author_confirms 三张表的完整字段内容。
"""
import json
import sqlite3

db = sqlite3.connect(r"d:\Project\personal\Biling\backend\biling.db")
db.row_factory = sqlite3.Row

print("author_confirms columns:",
      [c[1] for c in db.execute("PRAGMA table_info(author_confirms)")])

print("========== NOVELS ==========")
rows = db.execute(
    "SELECT id, title, background_type, genres, created_at, updated_at FROM novels"
).fetchall()
for r in rows:
    print("novel:", r["id"], "|", r["title"])
    print("  background_type:", repr(r["background_type"]))
    print("  genres:", repr(r["genres"]))
    print("  created_at:", r["created_at"], "updated_at:", r["updated_at"])

print()
print("========== AGENT_TASKS ==========")
tasks = db.execute(
    """SELECT id, novel_id, agent, status, error, created_at, updated_at
       FROM agent_tasks ORDER BY created_at DESC"""
).fetchall()
for t in tasks:
    print("task:", t["id"], "| novel:", t["novel_id"], "| agent:", t["agent"],
          "| status:", t["status"], "| err:", repr((t["error"] or "")[:80]))
    print("   created:", t["created_at"], "updated:", t["updated_at"])

print()
print("========== AUTHOR_CONFIRMS ==========")
confirms = db.execute(
    """SELECT id, novel_id, task_id, agent, confirm_key, status, answer, answer_meta, created_at
       FROM author_confirms ORDER BY created_at DESC"""
).fetchall()
for c in confirms:
    print("confirm:", c["id"], "| novel:", c["novel_id"], "| task:", c["task_id"])
    print("   agent:", c["agent"], "| key:", c["confirm_key"], "| status:", c["status"])
    print("   answer:", repr((c["answer"] or "")[:120]))
    print("   answer_meta:", repr((c["answer_meta"] or "")[:300]))
    print("   created:", c["created_at"])
