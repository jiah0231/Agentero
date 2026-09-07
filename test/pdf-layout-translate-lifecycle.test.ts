import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { it } from "vitest";

// Exercise the real hook with deterministic request completion and hook slots.
// No DOM or Tauri runtime is needed; this does not replace desktop UI testing.
const hookCode = ts.transpileModule(
	readFileSync(
		new URL(
			"../src/components/viewer/pdf/hooks/use-pdf-layout-translate.ts",
			import.meta.url,
		),
		"utf8",
	),
	{
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	},
).outputText;

type Item = {
	id: string;
	pageIndex: number;
	bbox: { x: number; y: number; w: number; h: number };
	kind: string;
	readingOrder: number;
	source: string;
	status?: string;
	translated?: string;
};

type RunOptions = {
	items: Item[];
	signal: AbortSignal;
	onUpdate: (items: Item[]) => void;
};

type Run = RunOptions & {
	resolve: (items: Item[]) => void;
	reject: (error: unknown) => void;
};

type Options = {
	docId: string;
	paperAbsPath: string;
	layoutRawRegions: Item[];
};

type View = {
	layoutTranslateItemsByPage: ReadonlyMap<number, readonly Item[]>;
	layoutTranslatePageStateByPage: ReadonlyMap<
		number,
		{ active: boolean; running: boolean }
	>;
	layoutTranslateRunning: boolean;
	layoutTranslateLabel: string;
	toggleLayoutTranslate: () => void;
	togglePageLayoutTranslate: (pageIndex: number) => void;
};

type EffectSlot = {
	deps: readonly unknown[];
	cleanup: (() => void) | undefined;
	effect: true;
};

function createHarness() {
	const slots: unknown[] = [];
	const runs: Run[] = [];
	const writes: unknown[][] = [];
	const errors: unknown[][] = [];
	let cursor = 0;
	let dirty = true;
	let effects: (() => void)[] = [];
	let stateWrites = 0;
	let view: View;
	let options: Options = {
		docId: "paper-a",
		paperAbsPath: "/vault/papers/a",
		layoutRawRegions: [0, 1].map((pageIndex) => ({
			id: `region-${pageIndex}`,
			pageIndex,
			bbox: { x: 0, y: 0, w: 1, h: 1 },
			kind: "text",
			readingOrder: pageIndex,
			source: `Source ${pageIndex}`,
		})),
	};
	const react = {
		useState<T>(initial: T): [T, (next: T | ((previous: T) => T)) => void] {
			const index = cursor++;
			if (!(index in slots)) slots[index] = initial;
			return [
				slots[index] as T,
				(next) => {
					slots[index] =
						typeof next === "function"
							? (next as (previous: T) => T)(slots[index] as T)
							: next;
					stateWrites++;
					dirty = true;
				},
			];
		},
		useRef<T>(initial: T): { current: T } {
			const index = cursor++;
			if (!(index in slots)) slots[index] = { current: initial };
			return slots[index] as { current: T };
		},
		useCallback: <T>(callback: T) => callback,
		useMemo: <T>(factory: () => T) => factory(),
		useEffect(
			effect: () => (() => void) | undefined,
			deps: readonly unknown[],
		) {
			const index = cursor++;
			const previous = slots[index] as EffectSlot | undefined;
			if (
				previous &&
				deps.every((dep, i) => Object.is(dep, previous.deps[i]))
			) {
				return;
			}
			effects.push(() => {
				previous?.cleanup?.();
				slots[index] = { deps, cleanup: effect(), effect: true };
			});
		},
	};
	const layout = {
		listTranslatableLayoutRegions: (regions: Item[]) => regions,
		toLayoutTranslateItems: (regions: Item[]) =>
			regions.map((item) => ({ ...item, status: "pending" })),
		currentLayoutTranslateCacheKey: () => ({
			providerId: "test",
			sourceLang: "en",
			targetLang: "zh",
			serviceKey: "test",
		}),
		readLayoutTranslateSidecar: async () => null,
		applyLayoutTranslateSidecar: (items: Item[]) => items,
		hasPendingLayoutTranslateItems: (items: Item[]) =>
			items.some((item) => item.status !== "done" || !item.translated?.trim()),
		groupLayoutTranslateItemsByPage(items: Item[]) {
			const pages = new Map<number, Item[]>();
			for (const item of items) {
				const page = pages.get(item.pageIndex) ?? [];
				page.push(item);
				pages.set(item.pageIndex, page);
			}
			return pages;
		},
		persistLayoutTranslateSidecarBestEffort: (...args: unknown[]) =>
			writes.push(args),
		runLayoutRegionTranslate(runOptions: RunOptions) {
			return new Promise<Item[]>((resolve, reject) => {
				runs.push({ ...runOptions, resolve, reject });
				runOptions.onUpdate(
					runOptions.items.map((item) =>
						item.status === "done" ? item : { ...item, status: "running" },
					),
				);
			});
		},
	};
	const modules: Record<string, unknown> = {
		react,
		"react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
		"@/lib/core/error": { errorText: String },
		"@/lib/core/notify": {
			notifyError: (...args: unknown[]) => errors.push(args),
		},
		"@/lib/pdf/layout": layout,
	};
	const exported = {} as { usePdfLayoutTranslate: (options: Options) => View };
	runInNewContext(hookCode, {
		exports: exported,
		AbortController,
		require(name: string) {
			assert.ok(Object.hasOwn(modules, name), `Unexpected import: ${name}`);
			return modules[name];
		},
	});
	function render(nextOptions?: Partial<Options>): View {
		options = { ...options, ...nextOptions };
		for (let pass = 0; pass < 10; pass++) {
			cursor = 0;
			dirty = false;
			// biome-ignore lint/correctness/useHookAtTopLevel: Test driver uses mocked hook slots, not React.
			view = exported.usePdfLayoutTranslate(options);
			const pendingEffects = effects;
			effects = [];
			for (const effect of pendingEffects) effect();
			if (!dirty) return view;
		}
		throw new Error("Hook did not settle");
	}
	render();
	return {
		runs,
		writes,
		errors,
		render,
		get view() {
			return view;
		},
		get stateWrites() {
			return stateWrites;
		},
		async flush() {
			for (let i = 0; i < 12; i++) await Promise.resolve();
			return render();
		},
		unmount() {
			for (const slot of slots) {
				if (slot && typeof slot === "object" && "effect" in slot) {
					(slot as EffectSlot).cleanup?.();
				}
			}
		},
	};
}

function completed(run: RunOptions, translated = "Translated"): Item[] {
	return run.items.map((item) => ({ ...item, status: "done", translated }));
}

it("ignores a replaced whole-document run's late result", async () => {
	const h = createHarness();
	h.view.toggleLayoutTranslate();
	await h.flush();
	h.view.toggleLayoutTranslate(); // stop
	h.render();
	h.view.toggleLayoutTranslate(); // restart before the old request settles
	await h.flush();
	assert.equal(h.runs.length, 2);
	const writes = h.writes.length;
	h.runs[0].resolve(completed(h.runs[0], "Old"));
	await h.flush();
	assert.equal(h.view.layoutTranslateRunning, true);
	assert.equal(h.writes.length, writes);
	h.runs[1].resolve(completed(h.runs[1], "New"));
	await h.flush();
	assert.equal(h.view.layoutTranslateRunning, false);
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(0)?.[0]?.translated,
		"New",
	);
});

it("does not let an old page run cancel a different page run", async () => {
	const h = createHarness();
	h.view.togglePageLayoutTranslate(0);
	await h.flush();
	h.view.togglePageLayoutTranslate(1);
	await h.flush();
	assert.equal(h.runs[0].signal.aborted, true);
	const writes = h.writes.length;
	h.runs[0].resolve(completed(h.runs[0]));
	await h.flush();
	assert.equal(h.view.layoutTranslateRunning, true);
	assert.equal(h.view.layoutTranslatePageStateByPage.get(0)?.running, false);
	assert.equal(h.writes.length, writes);
});

it("stops spinners immediately and keeps completed blocks", async () => {
	const h = createHarness();
	h.view.toggleLayoutTranslate();
	await h.flush();
	h.runs[0].onUpdate([
		completed(h.runs[0], "Keep this")[0],
		{ ...h.runs[0].items[1], status: "running" },
	]);
	h.render();
	h.view.toggleLayoutTranslate();
	h.render();
	assert.equal(h.view.layoutTranslateRunning, false);
	assert.equal(h.view.layoutTranslatePageStateByPage.get(1)?.running, false);
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(0)?.[0]?.translated,
		"Keep this",
	);
});

it("retries a stopped page before the old request settles", async () => {
	const h = createHarness();
	h.view.togglePageLayoutTranslate(0);
	await h.flush();
	h.view.togglePageLayoutTranslate(0); // stop
	h.render();
	h.view.togglePageLayoutTranslate(0); // retry
	await h.flush();
	assert.equal(h.runs.length, 2);
	assert.equal(h.view.layoutTranslateRunning, true);
});

for (const mode of ["document", "page"]) {
	it(`keeps overlays cleared after a late ${mode} result`, async () => {
		const h = createHarness();
		if (mode === "document") h.view.toggleLayoutTranslate();
		else h.view.togglePageLayoutTranslate(0);
		await h.flush();
		h.runs[0].onUpdate(completed(h.runs[0], "Visible progress"));
		h.render();
		h.view.toggleLayoutTranslate(); // stop
		h.render();
		h.view.toggleLayoutTranslate(); // clear
		h.render();
		const writes = h.writes.length;
		h.runs[0].resolve(completed(h.runs[0], "Late"));
		await h.flush();
		assert.equal(h.view.layoutTranslateItemsByPage.size, 0);
		assert.equal(h.writes.length, writes);
	});

	it(`discards late ${mode} results when switching documents`, async () => {
		const h = createHarness();
		if (mode === "document") h.view.toggleLayoutTranslate();
		else h.view.togglePageLayoutTranslate(0);
		await h.flush();
		h.render({ docId: "paper-b", paperAbsPath: "/vault/papers/b" });
		const writes = h.writes.length;
		h.runs[0].resolve(completed(h.runs[0], "Wrong document"));
		await h.flush();
		assert.equal(h.view.layoutTranslateItemsByPage.size, 0);
		assert.equal(h.writes.length, writes);
	});

	it(`ignores late ${mode} results after unmount`, async () => {
		const h = createHarness();
		if (mode === "document") h.view.toggleLayoutTranslate();
		else h.view.togglePageLayoutTranslate(0);
		await h.flush();
		h.unmount();
		const writes = h.writes.length;
		const stateWrites = h.stateWrites;
		h.runs[0].resolve(completed(h.runs[0]));
		for (let i = 0; i < 12; i++) await Promise.resolve();
		assert.equal(h.stateWrites, stateWrites);
		assert.equal(h.writes.length, writes);
	});
}

it("ignores stale progress and errors after a replacement starts", async () => {
	const h = createHarness();
	h.view.togglePageLayoutTranslate(0);
	await h.flush();
	h.view.togglePageLayoutTranslate(1);
	await h.flush();
	const writes = h.writes.length;
	h.runs[0].onUpdate(completed(h.runs[0], "Stale progress"));
	h.runs[0].reject(new Error("Late failure"));
	await h.flush();
	assert.equal(h.view.layoutTranslateRunning, true);
	assert.equal(h.errors.length, 0);
	assert.equal(h.writes.length, writes);
});

it("persists a successful current page and completes its job", async () => {
	const h = createHarness();
	h.view.togglePageLayoutTranslate(0);
	await h.flush();
	const writes = h.writes.length;
	h.runs[0].resolve(completed(h.runs[0], "Current result"));
	await h.flush();
	assert.equal(h.view.layoutTranslateRunning, false);
	assert.equal(h.view.layoutTranslateLabel, "pdf.layoutTranslate.clear");
	assert.equal(
		h.view.layoutTranslateItemsByPage.get(0)?.[0]?.translated,
		"Current result",
	);
	assert.equal(h.writes.length, writes + 1);
});
