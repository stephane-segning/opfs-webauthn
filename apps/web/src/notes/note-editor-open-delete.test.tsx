/**
 * Regression test for codex's P2 finding on PR #50: opening the
 * delete-confirm dialog while a prior save/archive error is still in
 * state should NOT carry that stale message into the freshly-opened
 * modal. The shared `error` slot would otherwise read as a delete
 * failure the user never actually triggered.
 *
 * The web app's vitest config is node-env (no jsdom), so instead of
 * driving the editor via DOM events we mock React's hooks, call
 * `NoteEditor` directly as a function, walk the returned element tree
 * to find the delete button, and invoke its `onClick`. The assertion
 * is then on the *order* of state setter calls: error must be cleared
 * to `null` before the dialog flips open, so the next render of the
 * dialog body sees a clean error slot.
 *
 * Mirrors the structural-render style of `delete-confirm-dialog.test.tsx`
 * — both side-step the missing jsdom by reaching for React internals
 * rather than pulling in @testing-library.
 */

import type * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted hook stubs — the `vi.mock` factory below replaces React's
// hooks with these, so the test can drive state deterministically.
const useStateMock = vi.fn();
const useRefMock = vi.fn();
const useEffectMock = vi.fn();

vi.mock("react", async () => {
	const actual = await vi.importActual<typeof import("react")>("react");
	return {
		...actual,
		useState: (...args: unknown[]) => useStateMock(...args),
		useRef: (...args: unknown[]) => useRefMock(...args),
		useEffect: (...args: unknown[]) => useEffectMock(...args),
	};
});

vi.mock("next-intl", () => ({
	// The component only calls `t(key)` — return the key so we can
	// match buttons without depending on the live translation table.
	useTranslations: () => (key: string) => key,
}));

vi.mock("../share/use-modal-dialog", () => ({
	useModalDialog: () => ({ current: null }),
}));

type AnyElement = React.ReactElement<{
	className?: string;
	onClick?: () => void;
	children?: unknown;
}>;

function isElement(node: unknown): node is AnyElement {
	return (
		typeof node === "object" &&
		node !== null &&
		"props" in (node as Record<string, unknown>) &&
		"type" in (node as Record<string, unknown>)
	);
}

function findByClassName(
	root: unknown,
	className: string,
): AnyElement | undefined {
	if (!isElement(root)) return undefined;
	if (root.props.className?.split(/\s+/).includes(className)) return root;
	const kids = root.props.children;
	const list = Array.isArray(kids) ? kids : [kids];
	for (const child of list) {
		const hit = findByClassName(child, className);
		if (hit) return hit;
	}
	return undefined;
}

describe("NoteEditor open-delete click handler", () => {
	beforeEach(() => {
		useStateMock.mockReset();
		useRefMock.mockReset();
		useEffectMock.mockReset();
		// `useEffect` is invoked at render time but its callback is
		// React-scheduled, so the mock is a no-op for this test.
		useEffectMock.mockImplementation(() => undefined);
		useRefMock.mockImplementation(() => ({ current: false }));
	});

	it("clears a stale `error` before opening the confirm dialog", async () => {
		// Spy setters for each of NoteEditor's useState slots, in
		// declaration order: draft, busy, error, confirmingDelete, mode.
		// `mode` (PR #48 markdown preview/edit toggle) was added to the
		// component after this test; ordering here mirrors the source.
		const setDraft = vi.fn();
		const setBusy = vi.fn();
		const setError = vi.fn();
		const setConfirmingDelete = vi.fn();
		const setMode = vi.fn();
		const stalePriorError = "save failed: storage offline";
		useStateMock
			.mockImplementationOnce((init: unknown) => [init, setDraft])
			.mockImplementationOnce(() => [false, setBusy])
			.mockImplementationOnce(() => [stalePriorError, setError])
			.mockImplementationOnce(() => [false, setConfirmingDelete])
			.mockImplementationOnce(() => ["preview", setMode]);

		// Import lazily so the `vi.mock("react", ...)` factory above has
		// already replaced the hooks by the time the module is evaluated.
		const { NoteEditor } = await import("./note-editor.js");

		const tree = NoteEditor({
			note: {
				id: "n1",
				title: "T",
				body: "B",
				updatedDay: 0,
				archived: false,
			},
			onCancel: () => {},
			onSave: async () => {},
			onArchive: async () => {},
			onDelete: async () => {},
		}) as AnyElement;

		const deleteButton = findByClassName(tree, "note-editor-delete");
		expect(deleteButton, "delete button must be in the tree").toBeDefined();
		expect(deleteButton?.props.onClick).toBeTypeOf("function");

		deleteButton?.props.onClick?.();

		// The fix: clear error first, *then* open the dialog. Asserting on
		// the call value (null) plus the relative invocation order locks
		// in both halves of the behavior.
		expect(setError).toHaveBeenCalledWith(null);
		expect(setConfirmingDelete).toHaveBeenCalledWith(true);
		const clearOrder = setError.mock.invocationCallOrder[0];
		const openOrder = setConfirmingDelete.mock.invocationCallOrder[0];
		expect(clearOrder).toBeDefined();
		expect(openOrder).toBeDefined();
		expect(clearOrder as number).toBeLessThan(openOrder as number);
	});
});
