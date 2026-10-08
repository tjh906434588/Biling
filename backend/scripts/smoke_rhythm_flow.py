# -*- coding: utf-8 -*-
"""节奏闭环逻辑验证（无需 LLM/网络/真实库）：标签校验、连续过渡统计、
节奏仪表盘（in-memory DB）、合规校验、骨架匹配。"""
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
import app.db.models as models  # noqa: F401  注册全部表到 Base.metadata

from app.agents.chapter_planner import dimension_compliance_check
from app.agents.context import derive_stage
from app.agents.platform_rules import (
    format_genre_storytelling_rules,
    format_rhythm_skeleton,
)
from app.services.rhythm_service import (
    RHYTHM_TAGS,
    compute_rhythm_dashboard,
    consecutive_transition_count,
    extract_volume_conflicts,
    format_stage_card,
    get_approved_rhythm_tags,
    high_spot_gap,
    is_valid_rhythm_tag,
)

PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail and not ok else ""))


def make_session() -> Session:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def seed_outline(db, novel_id, chapter_no, tag):
    db.add(models.Outline(
        novel_id=novel_id, chapter_no=chapter_no, version_no=1,
        content={
            "goal": "x",
            "writing_treatment": {"rhythm_tag": tag} if tag else {},
        },
        status="approved",
    ))


def main():
    # 1) 标签口径
    check("合法标签枚举", set(RHYTHM_TAGS) == {"爽点", "冲突", "过渡", "钩子", "高潮"})
    check("is_valid_rhythm_tag 合法/空", is_valid_rhythm_tag("爽点") and is_valid_rhythm_tag("") and is_valid_rhythm_tag(None))
    check("is_valid_rhythm_tag 非法", not is_valid_rhythm_tag("铺垫") and not is_valid_rhythm_tag("高潮章"))

    # 2) 连续过渡统计
    check("连续过渡=0", consecutive_transition_count(["爽点", "冲突", "钩子"]) == 0)
    check("连续过渡=1", consecutive_transition_count(["爽点", "冲突", "过渡"]) == 1)
    check("连续过渡=3 倒推", consecutive_transition_count(["过渡", "过渡", "过渡", "爽点"]) == 0)
    check("连续过渡=2 尾部", consecutive_transition_count(["爽点", "过渡", "过渡"]) == 2)
    check("未标注中断连续链", consecutive_transition_count(["爽点", "过渡", None, "过渡"]) == 1)

    # 3) 仪表盘（in-memory DB）
    db = make_session()
    nid = uuid.uuid4()
    seed_outline(db, nid, 1, "冲突")
    seed_outline(db, nid, 2, "爽点")
    seed_outline(db, nid, 3, "过渡")
    seed_outline(db, nid, 4, "过渡")
    db.commit()
    tags = get_approved_rhythm_tags(db, nid)
    check("approved 标签读取按章升序", [t for _, t in tags] == ["冲突", "爽点", "过渡", "过渡"])
    dash = compute_rhythm_dashboard(db, nid, up_to_chapter=5)
    print("---- 仪表盘输出（连续过渡≥2 场景）----")
    print(dash)
    print("--------------------------------------")
    check("仪表盘含连续过渡告警", "已连续 2 章为过渡章" in dash, dash)
    check("仪表盘含距爽点", "最近一个爽点/高潮章：第 2 章" in dash, dash)
    # 稀疏检测：第 5-14 章全为冲突（无爽点/高潮），第 11-14 章区间应告警
    for no in range(5, 15):
        seed_outline(db, nid, no, "冲突")
    db.commit()
    dash2 = compute_rhythm_dashboard(db, nid, up_to_chapter=15)
    print("---- 仪表盘输出（稀疏区间场景）----")
    print(dash2)
    print("--------------------------------------")
    check("仪表盘含稀疏告警", "无爽点/高潮" in dash2, dash2)
    db.close()

    # 4) 合规校验：execution 候选缺/非法 rhythm_tag
    ok_opts = [
        {"id": "e1", "text": "a", "beats": ["b1", "b2", "b3"], "ending_hook": "h", "satisfaction": "小胜", "rhythm_tag": "爽点"},
        {"id": "e2", "text": "b", "beats": ["b1", "b2", "b3"], "ending_hook": "h", "satisfaction": "推进感", "rhythm_tag": "过渡"},
        {"id": "e3", "text": "c", "beats": ["b1", "b2", "b3"], "ending_hook": "h", "satisfaction": "解气", "rhythm_tag": "冲突"},
    ]
    check("execution 合法候选通过", dimension_compliance_check("execution", ok_opts) is None)
    bad_opts = [dict(o) for o in ok_opts]
    bad_opts[0]["rhythm_tag"] = "水章"
    r = dimension_compliance_check("execution", bad_opts)
    check("execution 非法标签拦截", r is not None and "rhythm_tag" in r, r or "")
    miss_opts = [{"id": "e1", "text": "a", "beats": ["b1", "b2", "b3"], "ending_hook": "h", "satisfaction": "小胜"}]
    r2 = dimension_compliance_check("execution", miss_opts)
    check("execution 缺标签=未标注不拦截", r2 is None, r2 or "")

    # 6) 高潮间隔（每 10 章中高潮硬校验的信号源）
    check("high_spot_gap 无高潮=None", high_spot_gap(["爽点", "冲突", "过渡"]) is None)
    check("high_spot_gap 距2章", high_spot_gap(["高潮", "爽点", "过渡"]) == 2)
    check("high_spot_gap 距9章", high_spot_gap(["爽点", "高潮", "冲突", "过渡", "过渡", "冲突", "爽点", "过渡", "冲突", "钩子"]) == 8)
    check("high_spot_gap 尾部即高潮=0", high_spot_gap(["冲突", "高潮"]) == 0)

    # 7) 阶段卡（三阶段结构 + 量级档位 + 关键转折，从蓝图已有字段推导）
    blueprint = {
        "core_conflict": "主角与地方教育机构的规则盲区博弈",
        "volumes": [
            {"no": 1, "name": "懵懂入行", "focus": "毕业入职，站稳脚跟", "chapters_range": "1-30"},
            {"no": 2, "name": "自立门户", "focus": "创业扩张，对抗老东家", "chapters_range": "31-60"},
            {"no": 3, "name": "登顶", "focus": "行业话语权，终极对决", "chapters_range": "61-90"},
        ],
        "foreshadowing_plan": [
            {"plant_chapter": 1, "payoff_chapter": 12, "desc": "主角面板天赋的真实用途"},
            {"plant_chapter": 2, "payoff_chapter": 8, "desc": "旧相识身份伏笔"},
        ],
    }
    card_early = format_stage_card(blueprint, 3)
    print("---- 阶段卡（前期）----")
    print(card_early)
    print("----------------------")
    check("阶段卡前期含卷1", "第1卷" in card_early and "懵懂入行" in card_early, card_early[:60])
    check("阶段卡前期含量级档位", "立足期量级" in card_early, card_early)
    check("阶段卡含近期转折（第8章回收）", "第8章回收" in card_early, card_early)
    card_mid = format_stage_card(blueprint, 40)
    check("阶段卡中期含卷2/上升期", "第2卷" in card_mid and "上升期量级" in card_mid, card_mid[:60])
    check("阶段卡含本卷冲突/对手", "本阶段冲突/对手" in card_mid and "对抗老东家" in card_mid, card_mid)
    check("阶段卡无冲突时降级为全书主线", "本阶段冲突/对手（全书主线）" in card_early, card_early)
    check("阶段卡无蓝图返回空", format_stage_card(None, 5) == "")
    check("阶段卡无章号返回空", format_stage_card(blueprint, 0) == "")
    # focus 与 core_conflict 均空：冲突/对手行省略，但目标/量级仍在（结构不崩）
    bp_no_conflict = {"volumes": [{"no": 1, "name": "v1", "focus": "少年拜师学艺", "chapters_range": "1-30"}]}
    card_empty = format_stage_card(bp_no_conflict, 3)
    check("冲突/对手行三级降级不报错", "本阶段冲突/对手" not in card_empty and "本阶段核心目标" in card_empty and "量级档位" in card_empty, card_empty)

    # 7.5) 冲突线索提取（从 focus 原文，零 schema；词库跨题材通用）
    check("冲突线索提取", extract_volume_conflicts("与老机构老板利益冲突逐步激化、口碑封神") == ["与老机构老板利益冲突逐步激化"])
    check("冲突线索括号截断", extract_volume_conflicts("看遍行业唯利乱象（虚假承诺、贩卖焦虑、毁人前途）") == ["看遍行业唯利乱象"])
    check("冲突线索无命中空", extract_volume_conflicts("毕业入职，站稳脚跟") == [])
    check("冲突线索去重保序限3", extract_volume_conflicts("甲方冲突、乙方冲突、丙方冲突、丁方冲突、戊方冲突、己方冲突") == ["甲方冲突", "乙方冲突", "丙方冲突"])
    # 跨题材通用性：玄幻 / 言情 / 悬疑 / 生存危机措辞都能命中（不是按《2000》调的词表）
    check("玄幻冲突词命中", extract_volume_conflicts("秘境夺宝、仇敌围杀、心魔反噬、突破瓶颈") == ["秘境夺宝", "仇敌围杀", "心魔反噬"])
    check("言情冲突词命中", extract_volume_conflicts("误会加深、冷战开始、当众悔婚") == ["误会加深", "冷战开始", "当众悔婚"])
    check("悬疑冲突词命中", "追查命案现场" in extract_volume_conflicts("追查命案现场、真凶现身"))
    check("生存危机冲突词命中", extract_volume_conflicts("公司破产、负债累累、裁员风波") == ["公司破产", "负债累累", "裁员风波"])

    # 8) 阶段推导：按卷序号三等分（6 卷书 → 卷1-2 前期 / 卷3-4 中期 / 卷5-6 后期）
    bp6 = {
        "volumes": [
            {"no": 1, "name": "v1", "focus": "f1", "chapters_range": "1-85"},
            {"no": 2, "name": "v2", "focus": "f2", "chapters_range": "86-220"},
            {"no": 3, "name": "v3", "focus": "f3", "chapters_range": "221-355"},
            {"no": 4, "name": "v4", "focus": "f4", "chapters_range": "356-475"},
            {"no": 5, "name": "v5", "focus": "f5", "chapters_range": "476-595"},
            {"no": 6, "name": "v6", "focus": "f6", "chapters_range": "596-800"},
        ]
    }
    check("6卷 ch3=早期", derive_stage(3, bp6) == "early")
    check("6卷 卷2末=早期", derive_stage(220, bp6) == "early")
    check("6卷 卷3=中期", derive_stage(221, bp6) == "middle")
    check("6卷 卷5=后期", derive_stage(500, bp6) == "late")
    check("6卷 卷6=后期", derive_stage(700, bp6) == "late")
    check("阶段推导无蓝图=None", derive_stage(3, None) is None)
    check("阶段推导卷范围不覆盖=回退", derive_stage(900, bp6) == "late")

    # 9) 题材别名归一化：教育实业/年代奋斗 → 教育/现实 → 命中现实事业流
    gen = format_genre_storytelling_rules("realistic", ["教育实业", "年代奋斗"])
    check("别名归一化命中现实事业流", "现实事业流" in gen, gen[:50])

    # 5) 骨架匹配（内置题材族模板 + 默认）
    sk = format_rhythm_skeleton("realistic", ["都市", "职场"])
    check("现实事业流骨架命中", "现实事业流" in sk and "过渡章" in sk, sk[:60])
    sk2 = format_rhythm_skeleton("pure_fantasy", ["玄幻"])
    check("强爽流骨架命中", "强爽流" in sk2, sk2[:40])
    sk3 = format_rhythm_skeleton("alternate", ["都市", "异能"])
    check("都市高武骨架命中", "都市高武流" in sk3, sk3[:40])
    sk4 = format_rhythm_skeleton(None, [])
    check("无命中回退默认骨架", "黄金闭环" in sk4, sk4[:40])

    print(f"\n===== 结果：{len(PASS)} 通过 / {len(FAIL)} 失败 =====")
    if FAIL:
        print("失败项：", FAIL)
        sys.exit(1)


if __name__ == "__main__":
    main()
