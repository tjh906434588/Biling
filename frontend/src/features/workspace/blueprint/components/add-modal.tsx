/**
 * @file blueprint/add-modal.tsx
 * 「新增蓝图」弹窗（纯展示 + 回调）：顶部按钮行（导入大纲/清除导入/复制大纲模板 + 隐藏文件选择框）、
 * 输入文本框、导入后骨架检测提示区（OutlineCheckNotice）与底部操作栏（取消/生成/查看生成过程）。
 * 由 blueprint-panel.tsx 按 JSX 区块拆分——全部 state 与数据加载保留在父组件，本组件只做展示 + 回调；
 * 隐藏文件选择框 ref 与文本框 ref 随 DOM 一并内聚到本组件。
 */
"use client";

import { useRef, type ChangeEvent } from "react";
import type { OutlineCheckState } from "./blueprint-utils";
import Modal from "@/components/modal";
import InfoTip from "@/components/info-tip";
import { CostHint } from "@/lib/ai-status";

/** 「新增蓝图」弹窗：导入/清除/复制模板 + 输入框 + 骨架检测提示 + 生成操作栏。 */
export function BlueprintAddModal({
  open,
  onClose,
  importName,
  importing,
  outlineCheck,
  inputText,
  onInputChange,
  onImportFile,
  onClearImport,
  copied,
  onCopyTemplate,
  running,
  showStreamBtn,
  onShowStream,
  onGenerate,
}: {
  open: boolean;
  onClose: () => void;
  /** 导入的文档名；非空 = 当前内容是导入的文档（驱动「清除导入」按钮与 placeholder）。 */
  importName: string | null;
  importing: boolean;
  /** 导入后骨架检测状态：pending 锁定输入框并显示检测提示；done 显示缺失模块列表。 */
  outlineCheck: OutlineCheckState | null;
  inputText: string;
  onInputChange: (v: string) => void;
  onImportFile: (e: ChangeEvent<HTMLInputElement>) => void;
  onClearImport: () => void;
  /** 复制大纲模板的「已复制」反馈态。 */
  copied: boolean;
  onCopyTemplate: () => void;
  running: boolean;
  /** 是否显示「查看生成过程」按钮（本小说生成中）。 */
  showStreamBtn: boolean;
  onShowStream: () => void;
  onGenerate: () => void;
}) {
  // 隐藏的文件选择框 ref：点「导入大纲」按钮时触发其 click()
  const fileRef = useRef<HTMLInputElement | null>(null);
  // 文本框 ref：预留聚焦/滚动控制
  const boxRef = useRef<HTMLTextAreaElement | null>(null);

  return (
    <Modal
      open={open}
      title="新增蓝图"
      subtitle="蓝图 = 整本书的底稿：主题、核心冲突、人物弧光、分卷和伏笔计划。每一版都会保留，AI 写正文和大纲时只照着最新选中这版来。"
      onClose={onClose}
      maxWidth="max-w-xl"
      fill
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost px-4 py-1.5"
          >
            取消
          </button>
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline">
              <CostHint />
            </span>
            <button
              type="button"
              onClick={onGenerate}
              disabled={running || importing || outlineCheck?.status === "pending" || !inputText.trim()}
              className="btn btn-primary px-4 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {running ? "生成中…" : importName ? "按这份大纲生成全书方案" : "生成蓝图"}
            </button>
            {/* 点击生成后出现：打开生成过程弹窗（DeepSeek 风格，思考+正文流式滚动）；生成完毕即隐藏 */}
            {showStreamBtn && (
              <button
                type="button"
                onClick={onShowStream}
                className="btn btn-ghost px-3 py-1.5"
              >
                查看生成过程
              </button>
            )}
          </div>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {/* 生成期间按钮不隐藏、仅禁止点击（等蓝图生成完毕解除） */}
          <button
            type="button"
            className="btn btn-ghost px-3 py-1.5 text-sm"
            onClick={() => fileRef.current?.click()}
            disabled={importing || running || outlineCheck?.status === "pending"}
          >
            {importing ? "导入中…" : "导入大纲"}
          </button>
          {importName && (
            <button
              type="button"
              className="btn btn-ghost px-3 py-1.5 text-sm"
              onClick={onClearImport}
              disabled={running || outlineCheck?.status === "pending"}
            >
              清除导入
            </button>
          )}
          {/* 大纲模板参考：一键复制给 AI 识别的模板文本，? 悬浮说明在按钮内部、仅图标触发（InfoTip 渲染到 body，不被弹窗遮挡） */}
          <div className="ml-auto">
            <button
              type="button"
              className="btn btn-ghost px-3 py-1.5 text-sm"
              onClick={onCopyTemplate}
            >
              {copied ? "已复制" : "复制大纲模板"}
              <InfoTip side="bottom" align="right" width="w-80">
                <p className="mb-1 font-medium text-zinc-700 dark:text-zinc-200">
                  推荐结构（顺序可调整、模块可增删）
                </p>
                <ol className="list-decimal pl-4">
                  <li><b>全书总纲</b>：一句话故事 · 核心主题 · 全书体量（总字数/总章数/单章字数）· 核心冲突或叙事逻辑</li>
                  <li><b>分卷结构</b>：每卷 = 卷名 + 章节范围 + 本卷重点 + 核心剧情</li>
                  <li><b>人物设定</b>：主角 = 姓名/性格/起点→终点/成长转折；重要配角有则必写</li>
                  <li><b>主线与支线</b>：主线剧情走向 + 长效支线</li>
                  <li><b>世界观/规则</b>：题材相关才写（系统/力量体系/世界规则）</li>
                  <li><b>伏笔计划</b>：选填，有具体埋/揭安排才写（无则留空，由 AI 规划）</li>
                  <li><b>爽点/节奏规划</b>：通用模块，按前期/中期/后期排爽点·钩子·糖点，防节奏枯竭</li>
                  <li><b>差异化/卖点定位</b>：通用模块，对标作品 · 独特设定 · 立意/平台卖点，回答&ldquo;凭什么被记住&rdquo;</li>
                </ol>
                <p className="mt-1.5 text-[11px] text-zinc-400">
                  点击按钮复制模板文本：可粘贴进文本框作为底稿，或发给 AI 按模板整理你的大纲。
                </p>
              </InfoTip>
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".docx,.pdf,.md,.markdown,.txt"
            className="hidden"
            onChange={onImportFile}
          />
        </div>

        <textarea
          ref={boxRef}
          className="min-h-0 w-full flex-1 resize-none overflow-y-auto rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          placeholder={
            running
              ? "蓝图正在生成中，输入框暂时锁定；生成完成后即可继续编辑或重新导入。"
              : importName
                ? `已导入「${importName}」：下面是文档全文，可直接修改，完成后点「按这份大纲生成全书方案」。`
                : "作者补充要求（可选：类型/主题/风格取向…），也可以先点「导入大纲」把文档填进来。"
          }
          value={inputText}
          onChange={(e) => onInputChange(e.target.value)}
          // 生成中 / AI 骨架校验中禁止编辑：用 readOnly 而非 disabled，保证已有内容正常显示不被淡化
          readOnly={running || outlineCheck?.status === "pending"}
        />

        {/* 导入后骨架检测：先关键词初筛立即提示，AI 语义校验结果回来覆盖；只列缺失模块，可跳过直接生成。高度随内容自适应，最多占弹窗一半，超出自身滚动 */}
        {importName &&
          !running &&
          outlineCheck &&
          (outlineCheck.status === "pending" || outlineCheck.modules.some((m) => !m.ok)) && (
            <OutlineCheckNotice outlineCheck={outlineCheck} />
          )}
      </div>
    </Modal>
  );
}

/** 导入后骨架检测提示区：AI 校验进行中显示加载反馈；有缺失模块时列出补全建议（选填标注）。 */
function OutlineCheckNotice({ outlineCheck }: { outlineCheck: OutlineCheckState }) {
  return (
    <div className="shrink-0 max-h-[50%] overflow-y-auto rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 dark:border-amber-800 dark:bg-amber-950/60">
      {outlineCheck.status === "pending" && !outlineCheck.modules.some((m) => !m.ok) ? (
        /* AI 语义校验进行中且关键词初筛无缺失：给用户加载反馈（说明输入框为何暂时锁定） */
        <div className="flex items-center gap-2">
          <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
          <p className="text-xs font-semibold text-amber-800 dark:text-amber-200">
            AI 正在检查你的大纲缺不缺东西…（检查期间输入框暂时锁定，完成后即可编辑）
          </p>
        </div>
      ) : (
        <>
          <p className="text-xs font-semibold text-amber-800 dark:text-amber-200">
            {outlineCheck.status === "pending"
              ? "检查发现以下几项可以补全（AI 正在细看…）"
              : outlineCheck.source === "llm"
                ? "检查发现以下几项可以补全（可跳过直接生成）"
                : "检查发现以下几项可以补全（AI 检查暂时不可用，可跳过直接生成）"}
          </p>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {outlineCheck.modules
              .filter((m) => !m.ok)
              .map((m) => (
                <li key={m.id} className="text-xs leading-5 text-amber-700 dark:text-amber-300">
                  {m.optional ? (
                    <span className="text-amber-500/90 dark:text-amber-400/90">（选填建议）{m.reason}</span>
                  ) : (
                    m.reason
                  )}
                </li>
              ))}
          </ul>
        </>
      )}
    </div>
  );
}
