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
