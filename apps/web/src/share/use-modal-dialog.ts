/**
 * Open a `<dialog>` via the modal API so the browser handles
 * focus-trapping, backdrop rendering, and Esc-to-close. Falls back
 * to the non-modal `open` attribute on the rare runtime that
 * doesn't expose `showModal` (e.g. very old WebKit) so the dialog
 * remains visible instead of disappearing entirely.
 *
 * Returns a ref to attach to the `<dialog>`. The hook wires the
 * native `cancel` event (fired on Esc + backdrop click) to
 * `onClose` so callers don't have to remember to re-implement that
 * affordance.
 */

import { useEffect, useRef } from "react";

export function useModalDialog(onClose: () => void) {
	const ref = useRef<HTMLDialogElement | null>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (typeof dialog.showModal === "function") {
			try {
				dialog.showModal();
			} catch {
				// Already-open or detached dialogs throw; nothing useful
				// to do besides fall through to the open-attribute path.
				dialog.setAttribute("open", "");
			}
		} else {
			dialog.setAttribute("open", "");
		}

		const handleCancel = (event: Event): void => {
			event.preventDefault();
			onCloseRef.current();
		};
		dialog.addEventListener("cancel", handleCancel);
		return () => {
			dialog.removeEventListener("cancel", handleCancel);
			if (dialog.open) dialog.close();
		};
	}, []);

	return ref;
}
