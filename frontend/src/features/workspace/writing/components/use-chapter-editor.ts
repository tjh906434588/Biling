/**
 * @file writing/use-chapter-editor.ts
 * 正文就地编辑机制（从 writing-panel.tsx 按职责拆分）：
 * - 编辑区内容 + 镜像 ref（防抖保存 / AI 操作前读到的最新输入）；
 * - 人工版本（user_edit）：防抖 2s 自动落盘 + 切版本/卸载兜底落盘，切章用请求序号防竞态覆盖；
 * - AI 版本：确认式版本化——在 AI 版本上的修改只是「临时改动」，只停留在内存（stashRef 按版本
 *   暂存，切版本来回不丢），不自动派生新版本；只有用户点「存为新版本」（saveAsNewVersion）才真正
 *   派生 user_edit 子版本，避免改一个字符就多一个版本导致版本无限递增。
 * 关键机制：editTargetRef 记录当前编辑目标（章节号 + 版本 id + source），切版本/卸载时据此决定
 * 旧编辑是落盘（user_edit）还是暂存内存（AI 版本）。
 */
"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { deriveManualVersion, updateChapterVersion, type ChapterDetail, type ChapterVersion } from "@/lib/api";
import type { ShowToast } from "./panel-utils";

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
}

export function useChapterEditor({
  novelId,
  selectedVersion,
  detailChapterNo,
  setDetail,
  setSelectedVersionId,
  showToast,
}: UseChapterEditorOptions) {
  const [editText, setEditText] = useState("");
  const editTextRef = useRef("");
  const lastSavedTextRef = useRef("");
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">("saved");
  const saveTimerRef = useRef<number | null>(null);
  const editTargetRef = useRef<{ chapterNo: number; versionId: string; source: string } | null>(null);
  /** AI 版本上的未确认修改暂存（versionId → 临时正文）：切版本来回不丢；点「存为新版本」或恢复原状后清除。 */
  const stashRef = useRef<Map<string, string>>(new Map());

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
   * 仅对非 user_edit 版本有效；成功后选中新版本并清掉暂存。返回是否成功。
   */
  const saveAsNewVersion = useCallback(async (): Promise<boolean> => {
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
      stashRef.current.delete(target.versionId);
      // 先把「已落盘基线」对齐到当前文本，再切版本：切版本 effect 看到无差异就不会把
      // 刚确认的内容又写回暂存（否则切回原 AI 版本会错误恢复出一份临时改动）
      lastSavedTextRef.current = text;
      setSelectedVersionId(updated.id);
      return true;
    } catch (e) {
      showToast((e as Error).message, "error");
      return false;
    }
  }, [novelId, setDetail, setSelectedVersionId, showToast]);

  /**
   * AI 流程（定稿/提取/评价/优化）前的落盘钩子：
   * - 无改动 → 直接返回当前文本；
   * - 人工版本 → 原地 PATCH 落盘，返回落库后文本；
   * - AI 版本有未确认修改 → 不落库，提示用户先点「存为新版本」，返回 null（调用方据此中止流程）。
   */
  const flushSave = useCallback(async (): Promise<string | null> => {
    const target = editTargetRef.current;
    if (!target) return null;
    const text = editTextRef.current;
    if (text === lastSavedTextRef.current) return text;
    if (target.source !== "user_edit") {
      showToast("正文有未保存的修改：请先在「本章操作」点「存为新版本」，或把内容改回原样。", "warning");
      return null;
    }
    setSaveState("saving");
    try {
      const updated = await persistText(target, text);
      if (editTextRef.current === text) {
        lastSavedTextRef.current = updated.content;
        setSaveState("saved");
      }
      return updated.content;
    } catch (e) {
      setSaveState("dirty");
      showToast((e as Error).message, "error");
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistText]);

  // ── 正文就地编辑：镜像 ref + 切版本落盘/暂存 + 防抖自动保存 + 卸载兜底 ──
  /** 编辑区内容镜像到 ref：防抖保存 / AI 操作前读到的永远是最新输入。 */
  useEffect(() => {
    editTextRef.current = editText;
  }, [editText]);

  /** 选中版本变化：先把上一版本未保存的编辑落盘（人工版本）或暂存内存（AI 版本），
   *  再切换编辑目标到新版本内容（AI 版本有暂存时恢复暂存的临时改动）。 */
  useEffect(() => {
    const old = editTargetRef.current;
    if (old && editTextRef.current !== lastSavedTextRef.current) {
      if (old.source === "user_edit") {
        // 人工版本：照旧静默落盘
        const text = editTextRef.current;
        void persistText(old, text)
          .then((v) => {
            if (editTargetRef.current?.versionId === old.versionId) lastSavedTextRef.current = v.content;
          })
          .catch((e) => showToast((e as Error).message, "error"));
      } else {
        // AI 版本：修改仅暂存内存，不落库（确认式版本化：点「存为新版本」才真正创建新版本）
        stashRef.current.set(old.versionId, editTextRef.current);
      }
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
    const stashed = stashRef.current.get(selectedVersion.id);
    setEditText(stashed ?? selectedVersion.content);
    setSaveState(stashed != null && stashed !== selectedVersion.content ? "dirty" : "saved");

    // 仅依赖选中版本 id；详情章号变化不触发重切编辑目标
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVersion?.id]);

  /** 防抖自动保存：停止输入 2s 后自动落盘（仅人工版本）；AI 版本的修改只标记「已修改」，等用户确认。 */
  useEffect(() => {
    if (!editTargetRef.current) return;
    if (editText === lastSavedTextRef.current) {
      // 输入又回到已落盘内容：无未保存改动，撤销「已修改」标记；AI 版本同时清掉暂存（恢复原状）
      if (editTargetRef.current.source !== "user_edit") stashRef.current.delete(editTargetRef.current.versionId);
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

  /** 卸载兜底：防抖还没到就切页/关面板——人工版本未保存编辑静默落盘；AI 版本临时修改只进暂存。 */
  useEffect(() => {
    const stash = stashRef.current;
    return () => {
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const target = editTargetRef.current;
      if (target && editTextRef.current !== lastSavedTextRef.current) {
        if (target.source === "user_edit") {
          void persistText(target, editTextRef.current).catch((e) => showToast((e as Error).message, "error"));
        } else {
          stash.set(target.versionId, editTextRef.current);
        }
      }
    };
  // 卸载时使用当前闭包中的持久化函数，确保人工编辑也不会回写 AI 原版本。
  }, [novelId, persistText, showToast]);

  return {
    editText,
    setEditText,
    saveState,
    flushSave,
    saveAsNewVersion,
    editTextRef,
    editTargetRef,
  };
}
