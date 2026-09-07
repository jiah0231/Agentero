/**
 * Bulk (whole-document) translation of body-text layout regions.
 *
 * Its own hook because it shares nothing with hover or with the analysis run
 * beyond the region list it reads: one abortable job, progressive overlay items,
 * and the toolbar button's start → stop → retry/clear flow.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import {
	applyLayoutTranslateSidecar,
	currentLayoutTranslateCacheKey,
	groupLayoutTranslateItemsByPage,
	hasPendingLayoutTranslateItems,
	type LayoutTranslateItem,
	type LayoutTranslateJobStatus,
	listTranslatableLayoutRegions,
	type PdfLayoutRegion,
	persistLayoutTranslateSidecarBestEffort,
	readLayoutTranslateSidecar,
	runLayoutRegionTranslate,
	toLayoutTranslateItems,
} from "@/lib/pdf/layout";

export type UsePdfLayoutTranslateOptions = {
	docId: string;
	/** Pre-merge regions from {@link usePdfLayoutRegions}; the translate source. */
	layoutRawRegions: PdfLayoutRegion[] | null;
	/** Paper folder path; when present, full-document translations cache under source/. */
	paperAbsPath?: string | null;
	/** Stable paper identifier for per-document Agent session reuse. */
	paperKey?: string | null;
	/** Vault root passed to the Agent as its cwd. */
	vaultPath?: string | null;
};

export type PdfLayoutTranslate = {
	/** Progressive bulk-translate overlays (body text / abstract / header), bucketed by page. */
	layoutTranslateItemsByPage: ReadonlyMap<
		number,
		readonly LayoutTranslateItem[]
	>;
	/** One-page tag state, keyed by 0-based page index. */
	layoutTranslatePageStateByPage: ReadonlyMap<
		number,
		{ active: boolean; running: boolean }
	>;
	layoutTranslateRunning: boolean;
	/** Running, or finished with overlays still painted. */
	layoutTranslateActive: boolean;
	/** Toolbar button label for the current job phase. */
	layoutTranslateLabel: string;
	/** Toolbar button: start → stop → retry incomplete / clear complete. */
	toggleLayoutTranslate: () => void;
	/** Per-page tag: retry incomplete blocks, translate this page, or hide a complete page. */
	togglePageLayoutTranslate: (pageIndex: number) => void;
};

function mergeTranslatePageItems(
	items: readonly LayoutTranslateItem[],
	pageIndex: number,
	pageItems: readonly LayoutTranslateItem[],
): LayoutTranslateItem[] {
	return [
		...items.filter((it) => it.pageIndex !== pageIndex),
		...pageItems,
	].sort(
		(a, b) =>
			a.pageIndex - b.pageIndex ||
			a.readingOrder - b.readingOrder ||
			a.bbox.y - b.bbox.y ||
			a.bbox.x - b.bbox.x,
	);
}

/** Keep successful blocks when retrying a partial job, even before cache debounce flushes. */
function reuseCompletedTranslateItems(
	pending: readonly LayoutTranslateItem[],
	current: readonly LayoutTranslateItem[],
): LayoutTranslateItem[] {
	const byId = new Map(current.map((item) => [item.id, item]));
	return pending.map((item) => {
		const previous = byId.get(item.id);
		if (
			previous?.source === item.source &&
			previous.status === "done" &&
			previous.translated?.trim()
		) {
			return {
				...item,
				status: "done" as const,
				translated: previous.translated.trim(),
				error: undefined,
			};
		}
		return { ...item };
	});
}

/** Release interrupted blocks immediately; a cancelled runner may settle much later. */
function resetRunningTranslateItems(
	items: readonly LayoutTranslateItem[],
): LayoutTranslateItem[] {
	return items.map((item) =>
		item.status === "running" ? { ...item, status: "pending" } : item,
	);
}

export function usePdfLayoutTranslate({
	docId,
	layoutRawRegions,
	paperAbsPath,
	paperKey,
	vaultPath,
}: UsePdfLayoutTranslateOptions): PdfLayoutTranslate {
	const { t } = useTranslation("viewer");
	/** Progressive layout bulk-translate overlays (body text / abstract / header). */
	const [layoutTranslateJob, setLayoutTranslateJob] = useState<{
		status: LayoutTranslateJobStatus;
		items: LayoutTranslateItem[];
	}>({ status: "idle", items: [] });
	const layoutTranslateJobRef = useRef(layoutTranslateJob);
	layoutTranslateJobRef.current = layoutTranslateJob;
	const layoutTranslateAbortRef = useRef<AbortController | null>(null);
	const hiddenPageIndexesRef = useRef(new Set<number>());

	const applyHiddenPages = useCallback(
		(items: readonly LayoutTranslateItem[]) => {
			const hidden = hiddenPageIndexesRef.current;
			if (hidden.size === 0) return items.map((it) => ({ ...it }));
			return items
				.filter((it) => !hidden.has(it.pageIndex))
				.map((it) => ({ ...it }));
		},
		[],
	);

	const stopLayoutTranslate = useCallback(() => {
		layoutTranslateAbortRef.current?.abort();
		layoutTranslateAbortRef.current = null;
		setLayoutTranslateJob((prev) =>
			prev.status === "running"
				? {
						...prev,
						status: "cancelled",
						items: resetRunningTranslateItems(prev.items),
					}
				: prev,
		);
	}, []);

	const clearLayoutTranslate = useCallback(() => {
		layoutTranslateAbortRef.current?.abort();
		layoutTranslateAbortRef.current = null;
		hiddenPageIndexesRef.current.clear();
		setLayoutTranslateJob({ status: "idle", items: [] });
	}, []);

	const startLayoutTranslate = useCallback(() => {
		const raw = layoutRawRegions;
		if (!raw?.length) {
			notifyError(t("pdf.layoutTranslate.needLayout"));
			return;
		}
		const regions = listTranslatableLayoutRegions(raw);
		if (regions.length === 0) {
			notifyError(t("pdf.layoutTranslate.noText"));
			return;
		}
		layoutTranslateAbortRef.current?.abort();
		const ac = new AbortController();
		layoutTranslateAbortRef.current = ac;
		hiddenPageIndexesRef.current.clear();
		const cacheKey = currentLayoutTranslateCacheKey();
		const pendingItems = reuseCompletedTranslateItems(
			toLayoutTranslateItems(regions),
			layoutTranslateJobRef.current.items,
		);
		setLayoutTranslateJob({ status: "running", items: pendingItems });
		void (async () => {
			const sidecar = await readLayoutTranslateSidecar(paperAbsPath, cacheKey);
			if (ac.signal.aborted) return;
			const items = applyLayoutTranslateSidecar(pendingItems, sidecar);
			const needsRun = hasPendingLayoutTranslateItems(items);
			setLayoutTranslateJob({
				status: needsRun ? "running" : "done",
				items,
			});
			if (!needsRun) return;
			const finalItems = await runLayoutRegionTranslate({
				items,
				signal: ac.signal,
				paperKey,
				vaultPath,
				onUpdate: (next) => {
					if (ac.signal.aborted) return;
					persistLayoutTranslateSidecarBestEffort(paperAbsPath, cacheKey, next);
					setLayoutTranslateJob((prev) => ({
						status: prev.status === "cancelled" ? "cancelled" : "running",
						items: applyHiddenPages(next),
					}));
				},
			});
			// Cancellation/replacement owns the visible state now. A late result
			// must not restore cleared overlays or overwrite a newer sidecar write.
			if (ac.signal.aborted || layoutTranslateAbortRef.current !== ac) return;
			persistLayoutTranslateSidecarBestEffort(
				paperAbsPath,
				cacheKey,
				finalItems,
			);
			setLayoutTranslateJob({
				status: hasPendingLayoutTranslateItems(finalItems) ? "partial" : "done",
				items: applyHiddenPages(finalItems),
			});
		})()
			.catch((e) => {
				if (ac.signal.aborted) return;
				const message = errorText(e);
				notifyError(t("pdf.layoutTranslate.failed"), { description: message });
				setLayoutTranslateJob((prev) => ({
					status: "partial",
					items: prev.items,
				}));
			})
			.finally(() => {
				if (layoutTranslateAbortRef.current === ac) {
					layoutTranslateAbortRef.current = null;
				}
			});
	}, [
		layoutRawRegions,
		paperAbsPath,
		paperKey,
		vaultPath,
		applyHiddenPages,
		t,
	]);

	const startPageLayoutTranslate = useCallback(
		(pageIndex: number) => {
			const raw = layoutRawRegions;
			if (!raw?.length) {
				notifyError(t("pdf.layoutTranslate.needLayout"));
				return;
			}
			const regions = listTranslatableLayoutRegions(raw).filter(
				(region) => region.pageIndex === pageIndex,
			);
			if (regions.length === 0) {
				notifyError(t("pdf.layoutTranslate.noText"));
				return;
			}
			layoutTranslateAbortRef.current?.abort();
			const ac = new AbortController();
			layoutTranslateAbortRef.current = ac;
			hiddenPageIndexesRef.current.delete(pageIndex);
			const cacheKey = currentLayoutTranslateCacheKey();
			const pendingItems = reuseCompletedTranslateItems(
				toLayoutTranslateItems(regions),
				layoutTranslateJobRef.current.items.filter(
					(item) => item.pageIndex === pageIndex,
				),
			);
			setLayoutTranslateJob((prev) => ({
				status: "running",
				items: mergeTranslatePageItems(
					resetRunningTranslateItems(prev.items),
					pageIndex,
					pendingItems,
				),
			}));
			void (async () => {
				const sidecar = await readLayoutTranslateSidecar(
					paperAbsPath,
					cacheKey,
				);
				if (ac.signal.aborted) return;
				const pageItems = applyLayoutTranslateSidecar(pendingItems, sidecar);
				const needsRun = hasPendingLayoutTranslateItems(pageItems);
				setLayoutTranslateJob((prev) => {
					const merged = mergeTranslatePageItems(
						prev.items,
						pageIndex,
						pageItems,
					);
					return {
						status: needsRun
							? "running"
							: hasPendingLayoutTranslateItems(merged)
								? "partial"
								: "done",
						items: merged,
					};
				});
				if (!needsRun) return;
				const finalPageItems = await runLayoutRegionTranslate({
					items: pageItems,
					signal: ac.signal,
					paperKey,
					vaultPath,
					onUpdate: (next) => {
						if (ac.signal.aborted) return;
						persistLayoutTranslateSidecarBestEffort(
							paperAbsPath,
							cacheKey,
							next,
							{
								preserveExisting: true,
								replacePageIndexes: [pageIndex],
							},
						);
						setLayoutTranslateJob((prev) => ({
							status: prev.status === "cancelled" ? "cancelled" : "running",
							items: applyHiddenPages(
								mergeTranslatePageItems(prev.items, pageIndex, next),
							),
						}));
					},
				});
				// Only the current live run may publish or persist its final result.
				if (ac.signal.aborted || layoutTranslateAbortRef.current !== ac) return;
				persistLayoutTranslateSidecarBestEffort(
					paperAbsPath,
					cacheKey,
					finalPageItems,
					{
						preserveExisting: true,
						replacePageIndexes: [pageIndex],
					},
				);
				setLayoutTranslateJob((prev) => {
					const merged = mergeTranslatePageItems(
						prev.items,
						pageIndex,
						finalPageItems,
					);
					return {
						status: hasPendingLayoutTranslateItems(merged) ? "partial" : "done",
						items: applyHiddenPages(merged),
					};
				});
			})()
				.catch((e) => {
					if (ac.signal.aborted) return;
					const message = errorText(e);
					notifyError(t("pdf.layoutTranslate.failed"), {
						description: message,
					});
					setLayoutTranslateJob((prev) => ({
						status: "partial",
						items: prev.items,
					}));
				})
				.finally(() => {
					if (layoutTranslateAbortRef.current === ac) {
						layoutTranslateAbortRef.current = null;
					}
				});
		},
		[layoutRawRegions, paperAbsPath, paperKey, vaultPath, applyHiddenPages, t],
	);

	const togglePageLayoutTranslate = useCallback(
		(pageIndex: number) => {
			const pageItems = layoutTranslateJobRef.current.items.filter(
				(item) => item.pageIndex === pageIndex,
			);
			if (pageItems.some((item) => item.status === "running")) {
				stopLayoutTranslate();
				return;
			}
			if (pageItems.length > 0 && hasPendingLayoutTranslateItems(pageItems)) {
				startPageLayoutTranslate(pageIndex);
				return;
			}
			const pageActive = pageItems.some((item) => item.translated?.trim());
			if (pageActive) {
				hiddenPageIndexesRef.current.add(pageIndex);
				setLayoutTranslateJob((prev) => ({
					...prev,
					items: prev.items.filter((item) => item.pageIndex !== pageIndex),
				}));
				return;
			}
			startPageLayoutTranslate(pageIndex);
		},
		[startPageLayoutTranslate, stopLayoutTranslate],
	);

	const toggleLayoutTranslate = useCallback(() => {
		if (layoutTranslateJob.status === "running") {
			stopLayoutTranslate();
			return;
		}
		if (layoutTranslateJob.status === "partial") {
			startLayoutTranslate();
			return;
		}
		if (
			layoutTranslateJob.status === "done" ||
			layoutTranslateJob.status === "cancelled"
		) {
			// Complete/explicitly-cancelled overlays keep the original clear action.
			if (layoutTranslateJob.items.some((it) => it.translated)) {
				clearLayoutTranslate();
				return;
			}
		}
		startLayoutTranslate();
	}, [
		layoutTranslateJob,
		startLayoutTranslate,
		stopLayoutTranslate,
		clearLayoutTranslate,
	]);

	// Abort bulk translate when switching documents.
	useEffect(() => {
		if (!docId) return;
		layoutTranslateAbortRef.current?.abort();
		layoutTranslateAbortRef.current = null;
		hiddenPageIndexesRef.current.clear();
		setLayoutTranslateJob({ status: "idle", items: [] });
		return () => {
			layoutTranslateAbortRef.current?.abort();
		};
	}, [docId]);

	// Bucket once per job update (not per page); unchanged buckets keep their
	// previous array identity so memoized page overlays bail out while another
	// page streams.
	const layoutTranslateByPageRef = useRef<
		ReadonlyMap<number, readonly LayoutTranslateItem[]>
	>(new Map());
	const layoutTranslateItemsByPage = useMemo(() => {
		const grouped = groupLayoutTranslateItemsByPage(
			layoutTranslateJob.items,
			layoutTranslateByPageRef.current,
		);
		layoutTranslateByPageRef.current = grouped;
		return grouped;
	}, [layoutTranslateJob.items]);

	const layoutTranslatePageStateByPage = useMemo(() => {
		const states = new Map<number, { active: boolean; running: boolean }>();
		for (const item of layoutTranslateJob.items) {
			const state = states.get(item.pageIndex) ?? {
				active: false,
				running: false,
			};
			if (item.status === "running") {
				state.active = true;
				state.running = true;
			}
			if (item.translated?.trim()) {
				state.active = true;
			}
			states.set(item.pageIndex, state);
		}
		return states;
	}, [layoutTranslateJob.items]);

	const layoutTranslateRunning = layoutTranslateJob.status === "running";
	const layoutTranslateActive =
		layoutTranslateRunning ||
		layoutTranslateJob.items.some((it) => it.translated);
	const layoutTranslateLabel = layoutTranslateRunning
		? t("pdf.layoutTranslate.stop")
		: layoutTranslateJob.status === "partial"
			? t("pdf.layoutTranslate.start")
			: layoutTranslateActive
				? t("pdf.layoutTranslate.clear")
				: t("pdf.layoutTranslate.start");

	return {
		layoutTranslateItemsByPage,
		layoutTranslatePageStateByPage,
		layoutTranslateRunning,
		layoutTranslateActive,
		layoutTranslateLabel,
		toggleLayoutTranslate,
		togglePageLayoutTranslate,
	};
}
