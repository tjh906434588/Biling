/**
 * @file writing/use-chapter-editor.ts
 * 正文就地编辑机制（从 writing-panel.tsx 按职责拆分）：
 * - 编辑区内容 + 镜像 ref（防抖保存 / AI 操作前读到的最新输入）；
 * - 人工版本（user_edit）：防抖 2s 自动落盘 + 切版本/卸载兜底落盘，切章用请求序号防竞态覆盖；
 * - AI 版本：编辑只是「临时改动」，不自动落盘——必须点「存为新版本」才会派生 user_edit 子版本；
 *   未点按钮离开（切版本/切章/卸载）时修改不缓存、直接恢复原样；切走/发起 AI 流程前由外层
 *   弹三选一确认（存为新版本 / 放弃修改 / 取消）。
 * 关键机制：editTargetRef 记录当前编辑目标（章节号 + 版本 id + source），userEditedRef 标记
 * 真正被用户编辑过的版本 id，切版本/卸载时据此决定旧编辑是落盘（人工）还是丢弃（AI）。
 */
"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { deriveManualVersion, updateChapterVersion, type ChapterDetail, type ChapterVersion } from "@/lib/api";
import type { ShowToast } from "./panel-utils";

/** 未保存编辑处理选择（AI 版本上编辑后离开/发起 AI 流程时询问）。 */
export type UnsavedEditsChoice = "save" | "discard" | "cancel";

/** 编辑器 hook 的入参：面板侧传入选中版本、详情章号与详情写入通道。 */
interface UseChapterEditorOptions {
  novelId: string;
  /** 当前预览选中的正文版本；null = 无版本（编辑目标清空）。 */
  selectedVersion: NonNullable<ChapterDetail["versions"]>[number] | null;
  /** 当前详情章节号（编辑目标的一部分；null = 无详情）。 */
  detailChapterNo: number | null | undefined;
  /** 详情写入通道：落盘成功后把新内容回填进版本列表（避免旧内容覆盖新内容）。 */
  setDetail: Dispatch<SetStateAction<ChapterDetail | null>>;
  setSelectedVersionId: Dispatch<SetStateAction<string | null>>;
  showToast: ShowToast;
  /** AI 版本上有未保存编辑，需要用户决定怎么处理时触发（返回用户选择）。
   *  由父组件弹三选一确认框：存为新版本 / 放弃修改 / 取消。不传则降级为 toast 提示。 */
  onAskUnsavedEdits?: () => Promise<UnsavedEditsChoice>;
}

export function useChapterEditor({
  novelId,
  selectedVersion,
  detailChapterNo,
  setDetail,
  setSelectedVersionId,
  showToast,
  onAskUnsavedEdits,
}: UseChapterEditorOptions) {
  const [editText, setEditText] = useState("");
  const editTextRef = useRef("");
  const lastSavedTextRef = useRef("");
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">("saved");
  const saveTimerRef = useRef<number | null>(null);
  const editTargetRef = useRef<{ chapterNo: number; versionId: string; source: string } | null>(null);
  /** 真正被用户编辑过的版本 id 集合：只有用户输入过才算有未保存修改。
   *  不能用 editTextRef !== lastSavedTextRef 判断——快速切版本时 editTextRef 可能残留
   *  上一个版本的内容，会误把残留/空内容落盘到旧版本（曾导致版本被清空）。 */
  const userEditedRef = useRef<Set<string>>(new Set());
  /** showToast 镜像 ref：showToast 由父组件传入、每次渲染是新函数引用，
   *  若直接放进 effect 依赖会导致 effect 每次渲染重跑（卸载兜底会误清防抖定时器），
   *  故经 ref 稳定引用。 */
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;
  /** onAskUnsavedEdits 镜像 ref：同 showToast，经 ref 稳定引用避免 effect 依赖不稳定。 */
  const askRef = useRef(onAskUnsavedEdits);
  askRef.current = onAskUnsavedEdits;
  /** 最近一次「存为新版本」派生出的版本 id：供 AI 流程（如扩写）在确认后拿到最新选中的版本。
   *  使用方读完后应主动清空。 */
  const lastDerivedVersionIdRef = useRef<string | null>(null);

  /** 用户输入入口（textarea onChange）：标记当前版本有真实编辑，再更新正文。
   *  程序侧（切版本/格式化）直接调 setEditText，不经过这里，不会被误判为未保存修改。 */
  const handleUserEdit = useCallback(
    (v: string) => {
      const t = editTargetRef.current;
      if (t) userEditedRef.current.add(t.versionId);
      setEditText(v);
    },
    [setEditText],
  );

  /** 把正文落盘到人工版本（user_edit 原地 PATCH）；AI 版本不走这里（确认式版本化，见 saveAsNewVersion）。 */
  const persistText = useCallback(
    async (target: { chapterNo: number; versionId: string; source: string }, text: string) => {
      const updated = await updateChapterVersion(novelId, target.chapterNo, target.versionId, { content: text });
      setDetail((d) => {
        if (!d || d.chapter_no !== target.chapterNo) return d;
        const exists = d.versions.some((v) => v.id === updated.id);
        return { ...d, versions: exists ? d.versions.map((v) => (v.id === updated.id ? updated : v)) : [...d.versions, updated] };
      });
      return updated;
    },
    [novelId, setDetail],
  );

  /**
   * 把当前未确认的修改真正保存为一个新的人工版本（user_edit 子版本，原版本保留不变）。
   * 仅对非 user_edit 版本有效。成功后按 switchTarget 决定选中哪个版本：
   *  - 不传（undefined）：切到新版本（点「存为新版本」按钮场景）；
   *  - null：不切换，由调用方自行处理（如切章）；
   *  - 指定 id：切到该版本（切走前确认「存为新版本」时切到用户目标）。
   */
  const saveAsNewVersion = useCallback(
    async (switchTarget?: string | null): Promise<boolean> => {
      const target = editTargetRef.current;
      if (!target || target.source === "user_edit") return false;
      const text = editTextRef.current;
      try {
        const updated: ChapterVersion = await deriveManualVersion(novelId, target.chapterNo, target.versionId, {
          source: "user_edit",
          content: text,
        });
        setDetail((d) => {
          if (!d || d.chapter_no !== target.chapterNo) return d;
          const exists = d.versions.some((v) => v.id === updated.id);
          return { ...d, versions: exists ? d.versions.map((v) => (v.id === updated.id ? updated : v)) : [...d.versions, updated] };
        });
        userEditedRef.current.delete(target.versionId);
        // 先把「已落盘基线」对齐到当前文本，再切版本：切版本 effect 看到无差异就不会误判 dirty
        lastSavedTextRef.current = text;
        lastDerivedVersionIdRef.current = updated.id;
        if (switchTarget === null) {
          // 不切换，调用方自行处理
        } else if (switchTarget === undefined) {
          setSelectedVersionId(updated.id);
        } else {
          setSelectedVersionId(switchTarget);
        }
        return true;
      } catch (e) {
        showToast((e as Error).message, "error");
        return false;
      }
    },
    [novelId, setDetail, setSelectedVersionId, showToast],
  );

  /**
   * AI 流程（定稿/提取/评价/优化）前的落盘钩子：
   * - 无改动 → 直接返回当前文本；
   * - 人工版本 → 原地 PATCH 落盘，返回落库后文本；
   * - AI 版本有未确认修改 → 弹三选一确认（存为新版本 / 放弃修改 / 取消），按用户选择处理：
   *   存 → 派生人工子版本并切过去，返回新版本内容；弃 → 丢弃编辑返回原内容；取消 → 返回 null。
   *   未配置确认框时降级为 toast 提示并返回 null（调用方据此中止流程）。
   */
  const flushSave = useCallback(async (): Promise<string | null> => {
    const target = editTargetRef.current;
    if (!target) return null;
    const text = editTextRef.current;
    if (text === lastSavedTextRef.current) return text;
    if (target.source !== "user_edit") {
      if (!askRef.current) {
        showToast("正文有未保存的修改：请先在「本章操作」点「存为新版本」，或把内容改回原样。", "warning");
        return null;
      }
      const choice = await askRef.current();
      if (choice === "cancel") return null;
      if (choice === "save") {
        // 派生人工子版本并切到新版本；失败则中止流程
        const ok = await saveAsNewVersion();
        if (!ok) return null;
        return editTextRef.current;
      }
      // discard：丢弃编辑，恢复 AI 版本原内容
      setEditText(lastSavedTextRef.current);
      userEditedRef.current.delete(target.versionId);
      setSaveState("saved");
      return lastSavedTextRef.current;
    }
    setSaveState("saving");
    try {
      const updated = await persistText(target, text);
      if (editTextRef.current === text) {
        lastSavedTextRef.current = updated.content;
        userEditedRef.current.delete(target.versionId);
        setSaveState("saved");
      }
      return updated.content;
    } catch (e) {
      setSaveState("dirty");
      showToast((e as Error).message, "error");
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistText, saveAsNewVersion]);

  // ── 正文就地编辑：镜像 ref + 切版本落盘/暂存 + 防抖自动保存 + 卸载兜底 ──
  /** 编辑区内容镜像到 ref：防抖保存 / AI 操作前读到的永远是最新输入。 */
  useEffect(() => {
    editTextRef.current = editText;
  }, [editText]);

  /** 选中版本变化：先把上一版本未保存的编辑落盘（人工版本）或丢弃（AI 版本——未点「存为新版本」
   *  的编辑在离开时直接恢复原样，不暂存不落库），再切换编辑目标到新版本内容。
   *  切走前若有 AI 版本未保存编辑，由外层（index）先行二次确认，这里只做落盘/丢弃的收尾。 */
  useEffect(() => {
    const old = editTargetRef.current;
    // 只有用户真正编辑过的版本才处理：快速切版本时 editTextRef 可能残留
    // 上一版本内容，用 ref 比较会误判 dirty，把残留/空内容写进旧版本（曾导致版本被清空）。
    if (old && userEditedRef.current.has(old.versionId)) {
      if (old.source === "user_edit") {
        // 人工版本：照旧静默落盘
        const text = editTextRef.current;
        void persistText(old, text)
          .then((v) => {
            if (editTargetRef.current?.versionId === old.versionId) lastSavedTextRef.current = v.content;
          })
          .catch((e) => showToast((e as Error).message, "error"));
      }
      // AI 版本：不暂存不落库，直接丢弃（未点「存为新版本」的编辑离开即恢复原样）
      userEditedRef.current.delete(old.versionId);
    }
    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (!selectedVersion) {
      editTargetRef.current = null;
      lastSavedTextRef.current = "";
      setEditText("");
      setSaveState("saved");
      return;
    }
    editTargetRef.current = { chapterNo: detailChapterNo ?? 0, versionId: selectedVersion.id, source: selectedVersion.source };
    lastSavedTextRef.current = selectedVersion.content;
    setEditText(selectedVersion.content);
    setSaveState("saved");

    // 仅依赖选中版本 id；详情章号变化不触发重切编辑目标
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVersion?.id]);

  /** 防抖自动保存：停止输入 2s 后自动落盘（仅人工版本）；AI 版本的修改只标记「已修改」，等用户确认。 */
  useEffect(() => {
    if (!editTargetRef.current) return;
    if (editText === lastSavedTextRef.current) {
      // 输入又回到已落盘内容：无未保存改动，撤销「已修改」标记
      userEditedRef.current.delete(editTargetRef.current.versionId);
      setSaveState("saved");
      return;
    }
    setSaveState("dirty");
    // 确认式版本化：AI 版本上的修改不自动落盘，避免每改一点就多一个版本
    if (editTargetRef.current.source !== "user_edit") return;

    if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void flushSave();
    }, 2000);
    return () => {
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editText]);

  /** 卸载兜底：防抖还没到就切页/关面板——人工版本未保存编辑静默落盘；AI 版本未点「存为新版本」
   *  的编辑直接丢弃（恢复原样，不缓存）。依赖只含稳定引用（novelId / persistText），不含
   *  showToast——showToast 每次渲染是新引用，放进依赖会导致 effect 每次渲染重跑，cleanup 误清防抖定时器。 */
  useEffect(() => {
    return () => {
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const target = editTargetRef.current;
      if (target && userEditedRef.current.has(target.versionId)) {
        if (target.source === "user_edit") {
          void persistText(target, editTextRef.current).catch((e) => showToastRef.current((e as Error).message, "error"));
        }
        // AI 版本：不落库不缓存，直接丢弃
        userEditedRef.current.delete(target.versionId);
      }
    };
  // 卸载时使用当前闭包中的持久化函数，确保人工编辑也不会回写 AI 原版本。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [novelId, persistText]);

  return {
    editText,
    setEditText,
    handleUserEdit,
    saveState,
    flushSave,
    saveAsNewVersion,
    editTextRef,
    editTargetRef,
    lastDerivedVersionIdRef,
  };
}
