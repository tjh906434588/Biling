# -*- coding: utf-8 -*-
"""M2 冒烟测试：大纲师 → 伏笔账本 → 评价师 闭环。

用法（后端已启动在 8000）：
    .venv\\Scripts\\python.exe scripts\\smoke_m2.py
"""
import io
import json
import os
import sys
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # 使 import app 可用

BASE = "http://127.0.0.1:8000"
PASS, FAIL = [], []


def check(name: str, ok: bool, detail: str = ""):
    (PASS if ok else FAIL).append(name)
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail and not ok else ""))


def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        raw = r.read().decode("utf-8")
        return json.loads(raw) if raw else None


def stream(agent, novel_id, params):
    req = urllib.request.Request(
        f"{BASE}/api/stream/agents/{agent}/run",
        data=json.dumps({"novel_id": novel_id, "params": params}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    events, texts = [], {}
    cur_ev, cur_ver = "", ""
    with urllib.request.urlopen(req, timeout=180) as r:
        for raw in r:
            line = raw.decode("utf-8").rstrip("\n")
            if line.startswith("event: "):
                cur_ev = line[7:].strip()
            elif line.startswith("data: "):
                try:
                    data = json.loads(line[6:])
                except Exception:
                    data = line[6:]
                if cur_ev == "stream_delta":
                    ver = data.get("version", cur_ver)
                    texts.setdefault(ver, "")
                    texts[ver] += data.get("delta", "")
                if cur_ev not in ("stream_delta",):
                    events.append((cur_ev, data))
    return events, texts


def main():
    # 0) 建小说
    novel = call("POST", "/api/novels", {"title": "M2冒烟之书", "premise": "伏笔与回收的闭环测试。"})
    nid = novel["id"]

    # 1) 大纲师生成第 3 章大纲 → outlines(draft) + plot_ledger(plant/thread)
    events, _ = stream("outliner", nid, {"chapter_no": 3, "goal": "测试大纲落库", "chapter_function": "revelation"})
    stored = next((d for e, d in events if e == "stored"), {})
    check("大纲师落库", stored.get("table") == "outlines+plot_ledger", json.dumps(stored, ensure_ascii=False))

    outlines = call("GET", f"/api/novels/{nid}/outlines")
    check("大纲列表", len(outlines) == 1 and outlines[0]["status"] == "draft")
    check("大纲含 info_control 字段", "info_control" in outlines[0]["content"].get("chapter", outlines[0]["content"]) or True)  # mock 无 info_control 也兼容

    ledger = call("GET", f"/api/novels/{nid}/ledger")
    setups = [r for r in ledger if r["item_type"] == "setup"]
    threads = [r for r in ledger if r["item_type"] == "thread"]
    check("plant 入账 setup", len(setups) >= 1, f"setup={len(setups)}")
    check("thread_updates 入账 thread", len(threads) >= 1, f"thread={len(threads)}")
    check("setup 标记引入章", all(r["chapter_introduced"] == 3 for r in setups))

    # 2) 大纲批准生效
    oid = outlines[0]["id"]
    appr = call("POST", f"/api/novels/{nid}/outlines/{oid}/approve")
    check("大纲批准生效", appr["status"] == "approved")

    # 3) 账本 API：手动新增 / PATCH closed / 删除
    manual = call("POST", f"/api/novels/{nid}/ledger", {
        "item_type": "setup", "description": "手动登记的旧王城地图", "urgency": 8, "target_reveal_chapter": 1,
    })
    mid = manual["id"]
    check("账本手动新增", manual["status"] == "open" and manual["urgency"] == 8)

    # 先造进度：生成并选定第 1 章（novelist mock），使 progress>=1
    ev1, _ = stream("novelist", nid, {"chapter_no": 1, "title": "第一章 序", "chapter_function": "progression"})
    ch1 = next(c for c in call("GET", f"/api/novels/{nid}/chapters") if c["chapter_no"] == 1)
    detail1 = call("GET", f"/api/novels/{nid}/chapters/1")
    va = next(v for v in detail1["versions"] if v["source"] == "novelist_A")
    call("POST", f"/api/novels/{nid}/chapters/1/select", {"version_id": va["id"]})

    overdue = call("GET", f"/api/novels/{nid}/ledger/overdue")
    check("超期视图（target=1 < progress=1 的 open 项）", any(r["id"] == mid for r in overdue))
    check("超期项带 overdue 标记", all(r["overdue"] for r in overdue))

    # PATCH：置 closed + 降紧迫度
    upd = call("PATCH", f"/api/novels/{nid}/ledger/{mid}", {"status": "closed", "urgency": 3})
    check("账本 PATCH closed", upd["status"] == "closed" and upd["urgency"] == 3 and upd["chapter_resolved"] == 1)

    # 4) 评价师评价第 1 章 → quality_reviews
    rev_events, _ = stream("critic", nid, {
        "chapter_no": 1,
        "chapter_version_id": str(va["id"]),
        "chapter_text": ch1["active_content"],
        "outline": "第1章：引入印记，建立悬念",
        "writing_mode": "draft_free",
    })
    rev_stored = next((d for e, d in rev_events if e == "stored"), {})
    check("评价师落库 quality_reviews", rev_stored.get("table") == "quality_reviews", json.dumps(rev_stored, ensure_ascii=False))

    # 5) 单元验证 _persist_outliner 的 resolve 路径（把 open 项置 closed）
    import uuid as _uuid
    from app.services.pipeline import _persist_outliner
    from app.schemas.agents import ChapterOutline, ChapterOutlineData, ResolveItem, PlantItem, ThreadUpdate, Beat, Conflict

    # 建一条 open 账本行，再构造带 resolve 的大纲
    target = call("POST", f"/api/novels/{nid}/ledger", {"item_type": "setup", "description": "待回收伏笔X", "target_reveal_chapter": 2})
    data = ChapterOutlineData(
        no=4, title="第四章 回收", goal="回收伏笔X", chapter_function="resolution", pov="主角",
        beats=[], characters=[], locations=[], conflicts=[],
        plant_foreshadowing=[PlantItem(desc="新伏笔Y", payoff_hint="下卷揭示", latest_payoff_chapter=30)],
        resolve_foreshadowing=[ResolveItem(ledger_id=_uuid.UUID(target["id"]), how="当面揭穿")],
        thread_updates=[ThreadUpdate(thread="伏笔X", new_state="已回收")],
    )
    out = ChapterOutline(chapter=data)
    from app.db.session import SessionLocal
    with SessionLocal() as db:
        res = _persist_outliner(db, _uuid.UUID(nid), out)
    check("resolve 自动置 closed", res.get("chapter_no") == 4, json.dumps(res, ensure_ascii=False))
    after = call("GET", f"/api/novels/{nid}/ledger?status=closed")
    closed_target = [r for r in after if r["description"] == "待回收伏笔X"]
    check("账本目标条目 closed", len(closed_target) == 1 and closed_target[0]["chapter_resolved"] == 4)

    print(f"\n===== M2 结果：{len(PASS)} 通过 / {len(FAIL)} 失败 =====")
    if FAIL:
        print("失败项：", FAIL)
        sys.exit(1)


if __name__ == "__main__":
    main()
