"""M3/M4 冒烟：blueprints / concepts / style / detect / graph / memory / models routes。

用法：python scripts/smoke_m34.py [novel_id]
缺省取库中第一本小说。
"""
import json
import sys
import uuid

import httpx

BASE = "http://127.0.0.1:8000/api"
client = httpx.Client(timeout=60)


def ok(name: str, resp: httpx.Response) -> dict:
    status = "OK" if resp.status_code < 300 else f"FAIL({resp.status_code})"
    print(f"[{status}] {name} -> {resp.text[:200]}")
    if resp.status_code >= 300:
        raise SystemExit(f"冒烟失败：{name} {resp.text[:300]}")
    try:
        return resp.json()
    except Exception:
        return {}


def main():
    novel_id = sys.argv[1] if len(sys.argv) > 1 else None
    if novel_id is None:
        import sqlite3

        conn = sqlite3.connect("biling.db")
        row = conn.execute("select id from novels limit 1").fetchone()
        conn.close()
        if row is None:
            print("库中没有项目，请先用 /api/novels 创建一个再跑冒烟。")
            return
        novel_id = str(row[0])
    n = novel_id

    # 1. blueprints
    ok("GET blueprints", client.get(f"{BASE}/novels/{n}/blueprints"))
    ok("GET blueprints/active", client.get(f"{BASE}/novels/{n}/blueprints/active"))

    # 2. concepts
    cards = ok("GET concepts", client.get(f"{BASE}/novels/{n}/concepts"))

    # 3. style
    ok("GET style", client.get(f"{BASE}/novels/{n}/style"))
    learn = ok(
        "POST style/learn",
        client.post(
            f"{BASE}/novels/{n}/style/learn",
            json={
                "diffs": [
                    {"id": "d1", "original": "他感到非常难过，但是仍然坚持着继续向前走。", "edited": "他咬了咬牙，继续往前走。"},
                    {"id": "d2", "original": "总而言之，这次行动终于圆满结束了。", "edited": "行动结束了。"},
                ]
            },
        ),
    )

    # 4. detect
    det = ok(
        "POST detect",
        client.post(
            f"{BASE}/novels/{n}/detect",
            json={
                "text": "总而言之，这个故事终于迎来了结局。首先，他感到非常难过，但是仍然坚持着。其次，他仿佛看到了希望。最后，他决定继续前进。"
            },
        ),
    )

    # 5. graph
    ok("GET graph", client.get(f"{BASE}/novels/{n}/graph"))
    rel = ok(
        "POST graph/relations",
        client.post(
            f"{BASE}/novels/{n}/graph/relations",
            json={"source": "岚", "target": "主角", "relation": "师徒", "type": "static"},
        ),
    )
    if rel.get("id"):
        ok("DELETE graph/relations", client.delete(f"{BASE}/novels/{n}/graph/relations/{rel['id']}"))

    # 6. memory review
    ok("GET memory-review", client.get(f"{BASE}/novels/{n}/memory-review"))

    # 7. models routes CRUD
    ok("GET models/routes", client.get(f"{BASE}/models/routes"))
    r = ok(
        "POST models/routes",
        client.post(
            f"{BASE}/models/routes",
            json={"task_type": "chat", "provider": "deepseek", "model": "deepseek-chat", "is_default": True},
        ),
    )
    if r.get("id"):
        ok("DELETE models/routes", client.delete(f"{BASE}/models/routes/{r['id']}"))

    print("\nM3/M4 冒烟全部通过")


if __name__ == "__main__":
    main()
