/**
 * @file writing/use-chapter-editor.ts
 * 正文就地编辑机制（从 writing-panel.tsx 按职责拆分，行为完全不变）：
 * - 编辑区内容 + 镜像 ref（防抖保存 / AI 操作前落盘读到的最新输入）；
 * - 「防抖 2s 自动落盘 + 切版本/卸载兜底落盘」，切章用请求序号防竞态覆盖；
 * - reviewStale/reviewBaselineRef：正文在最近一次评价后是否被改过（评价栏「重新评价」提示的依据）。
 * 关键机制：editTargetRef 记录当前编辑目标（章节号 + 版本 id），切版本/卸载时据此把旧编辑落盘；
 * 落盘后若内容与已评价基线一致（改完又恢复原样）则撤销「重新评价」提示。
 */
"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { updateChapterVersion, type ChapterDetail } from "@/lib/api";
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
  showToast: ShowToast;
}

export function useChapterEditor({
  novelId,
  selectedVersion,
  detailChapterNo,
  setDetail,
  showToast,
}: UseChapterEditorOptions) {
  const [editText, setEditText] = useState("");
  const editTextRef = useRef("");
  const lastSavedTextRef = useRef("");
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">("saved");
  const saveTimerRef = useRef<number | null>(null);
  const editTargetRef = useRef<{ chapterNo: number; versionId: string } | null>(null);
  /** 正文在最近一次评价后是否被修改过：已有评价对应当前内容过期 → 评价栏出现「重新评价」提示。 */
  const [reviewStale, setReviewStale] = useState(false);
  /** 已评价基线内容：评价所基于的版本正文。编辑保存后若内容与它一致（改完又恢复原样），
   *  说明现有评价仍然有效 → 撤销「重新评价」提示；重新评价完成或切换版本时更新为最新基准。 */
  const reviewBaselineRef = useRef<string | null>(null);

  /** 立即落盘当前未保存编辑（防抖触发 / AI 操作前 / 切版本 / 卸载时复用）。返回落库后的文本。 */
  const flushSave = useCallback(async (): Promise<string | null> => {
    const target = editTargetRef.current;
    if (!target) return null;
    const text = editTextRef.current;
    if (text === lastSavedTextRef.current) return text; // 无改动
    setSaveState("saving");
    try {
      const updated = await updateChapterVersion(novelId, target.chapterNo, target.versionId, { content: text });
      // 竞态守卫：保存期间用户又改了 → 本次结果不标记 saved（保持 dirty，防抖会再保存），
      // 且不回填旧文本到详情，避免旧内容覆盖新内容
      if (editTextRef.current === text) {
        lastSavedTextRef.current = updated.content;
        setSaveState("saved");
        // 落盘内容与已评价基线一致（改动后又恢复原样）→ 现有评价仍有效，撤销「重新评价」提示
        if (reviewBaselineRef.current != null && updated.content === reviewBaselineRef.current) {
          setReviewStale(false);
        }
        setDetail((d) =>
          d
            ? { ...d, versions: d.versions.map((v) => (v.id === target.versionId ? { ...v, content: updated.content } : v)) }
            : d,
        );
      }
      return updated.content;
    } catch (e) {
      setSaveState("dirty");
      showToast((e as Error).message, "error");
      return null;
    }
    // showToast 只转发到全局 message API，行为恒定，不进依赖（与原实现一致）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [novelId, setDetail]);

  // ── 正文就地编辑：镜像 ref + 切版本落盘 + 防抖自动保存 + 卸载兜底 ──
  /** 编辑区内容镜像到 ref：防抖保存 / AI 操作前落盘读到的永远是最新输入。 */
  useEffect(() => {
    editTextRef.current = editText;
  }, [editText]);

  /** 选中版本变化：先把上一版本未保存的编辑静默落盘，再切换编辑目标到新版本内容。 */
  useEffect(() => {
    const old = editTargetRef.current;
    if (old && editTextRef.current !== lastSavedTextRef.current) {
      const text = editTextRef.current;
      void updateChapterVersion(novelId, old.chapterNo, old.versionId, { content: text })
        .then((v) => {
          // 期间已切走（editTarget 已换）则不更新 lastSaved，避免把旧文本当新目标已保存
          if (editTargetRef.current?.versionId === old.versionId) lastSavedTextRef.current = v.content;
          setDetail((d) =>
            d
              ? { ...d, versions: d.versions.map((x) => (x.id === old.versionId ? { ...x, content: v.content } : x)) }
              : d,
          );
        })
        .catch(() => undefined);
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
    editTargetRef.current = { chapterNo: detailChapterNo ?? 0, versionId: selectedVersion.id };
    lastSavedTextRef.current = selectedVersion.content;
    setEditText(selectedVersion.content);
    setSaveState("saved");
    // 切换版本后评价基线随之更换：清除「待重新评价」标记，让当前版本按新评价基线重新计算
    setReviewStale(false);
    reviewBaselineRef.current = selectedVersion.content;
    // 与原实现一致：仅依赖选中版本 id（详情章号变化不触发重切编辑目标）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVersion?.id]);

  /** 防抖自动保存：停止输入 2s 后自动落盘；无改动不触发。 */
  useEffect(() => {
    if (!editTargetRef.current) return;
    if (editText === lastSavedTextRef.current) {
      // 输入又回到已落盘内容：无未保存改动，撤销「已修改」标记；
      // 若等于已评价基线（改完即恢复原样），现有评价仍有效，同时撤销「重新评价」提示
      setSaveState("saved");
      if (reviewBaselineRef.current != null && editText === reviewBaselineRef.current) setReviewStale(false);
      return;
    }
    setSaveState("dirty");
    // 正文发生改动：已有评价过期，评价栏出现「重新评价」提示（落盘后仍保持，直到重新评价）
    setReviewStale(true);
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

  /** 卸载兜底：防抖还没到就切页/关面板，把未保存编辑静默落盘。 */
  useEffect(() => {
    return () => {
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const target = editTargetRef.current;
      if (target && editTextRef.current !== lastSavedTextRef.current) {
        void updateChapterVersion(novelId, target.chapterNo, target.versionId, {
          content: editTextRef.current,
        }).catch(() => undefined);
      }
    };
  }, [novelId]);

  return {
    editText,
    setEditText,
    saveState,
    flushSave,
    reviewStale,
    setReviewStale,
    editTextRef,
    editTargetRef,
    reviewBaselineRef,
  };
}
