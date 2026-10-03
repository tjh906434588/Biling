/**
 * @file constants/settings.ts
 * 设定页相关共享常量：设定类型规格 loadSettingTypes（类型/标签/示例/判定标准/填写建议，驱动设定表单与类型栏）、
 * 一键复制给外部 AI 的导入指令 IMPORT_INSTRUCTION。
 */
import type { SettingType } from "@/types/api";
import { SETTING_TYPES } from "./api";
import { loadMetaDict } from "@/lib/meta-dict";

/** 设定类型规格（后端 meta.py 单一源经字典下发：label/hint/示例/判定标准/填写建议）。
 *  key 静态清单 = SETTING_TYPES（「常量即类型」），规格文案不在此维护。 */
export interface SettingSpec {
  key: SettingType;
  label: string;
  hint: string;
  example: string;
  judge: string;
  name_hint: string;
  desc_hint: string;
  constitution_advice: string;
}

/** 拉取设定类型规格（后端单一源，统一缓存）；失败回退 key + 空规格（不阻塞表单）。 */
export async function loadSettingTypes(): Promise<SettingSpec[]> {
  try {
    return await loadMetaDict<SettingSpec[]>("setting_types");
  } catch {
    return SETTING_TYPES.map((key) => ({
      key, label: key, hint: "", example: "", judge: "", name_hint: "", desc_hint: "", constitution_advice: "",
    }));
  }
}

/** 一键复制的导入指令：发给外部 AI（豆包/DeepSeek 等），让它们按本产品格式输出设定 JSON。 */
export const IMPORT_INSTRUCTION = `你是小说设定整理助手。请把用户提供的关于小说的设定描述，拆解成结构化设定条目。

【输出格式】只输出一个严格的 JSON 数组，不要任何多余文字，不要用 markdown 代码块包裹。每个元素：
{
  "type": "character 或 location 或 faction 或 world_rule 或 item 或 concept",
  "name": "设定名称",
  "constitution": "不可变内容（死规矩，AI 永不违背）",
  "dynamic": "可变内容（随剧情演变的性格/状态，没有就填空字符串）",
  "role_rank": "仅 type 为 character 时必填：protagonist 或 major 或 minor 或 extra",
  "appear_from": 5,
  "appear_until": 20,
  "stages": ["early", "late"]
}

【类型判定标准】
- character 角色：会说话、有自我意识的活物/系统
- location 地点：故事发生的场所
- faction 势力：组织/家族/阵营
- world_rule 世界规则：所有角色都遵守的法则（如人人都有系统）
- item 物品：有来历的道具/宝物
- concept 概念：世界观里的特有名词/机制

【出现时机（可选，防后期设定提前出现）】
- stages：设定生效的故事阶段（大致范围），可多选：early（前期）/ middle（中期）/ late（后期）；不写表示不限制
- appear_from / appear_until：在所选阶段内的更细限定（如「后期」里第 25~30 章才出现）；不写 = 整个所选阶段生效；必须搭配 stages 使用
- appear_ranges：可指定多段不连续范围（如跳过中期、只在前/后期出现）：[{ "from": 1, "until": 266 }, { "from": 534, "until": 800 }]；与 appear_from / appear_until 二选一，出现时以前者为准

【要求】
1. 每一条必须有 type 和 name；
2. constitution 写死规矩（身份、血统、世界法则、核心功能等）；dynamic 写可演变的（性格成长、当前状态、物品去向等），没有就留空；
3. 角色按戏份定 role_rank：主角 protagonist / 重要配角 major / 次要配角 minor / 龙套 extra；
4. 拆分要细：一个角色一条、一个地点一条，不要把多个塞进一条；
5. 后期才登场的设定（如后期创立的公司）务必标上 appear_from 和/或 stages，避免前期章节提前出现。

现在请根据用户提供的描述，输出 JSON 数组。`;
