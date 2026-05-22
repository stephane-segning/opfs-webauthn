/**
 * Regression test for the delete-confirmation dialog's failure surface.
 *
 * Background: gemini-code-assist flagged on PR #50 that a failed
 * hard-delete writes its error to `NoteEditor`'s background, but a
 * modal `<dialog>` paints over the editor — so the user sees the
 * confirm button briefly disable and re-enable with no feedback. The
 * fix passes the error string into `DeleteConfirmDialog` and renders
 * it inside the modal, where the user can actually see it.
 *
 * The web app's vitest config is node-env (no jsdom), so we drive
 * `react-dom/server` directly and assert against the serialised HTML.
 * That's enough to verify the structural promise: when an error is
 * provided, an alert-role paragraph carrying the message is emitted
 * inside the dialog; when it isn't, no alert renders.
 */

import { NextIntlClientProvider } from "next-intl";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import messages from "../i18n/messages/en.json" with { type: "json" };
import { DeleteConfirmDialog } from "./note-editor.js";

function render(node: React.ReactNode): string {
	// `timeZone` silences a noisy next-intl warning at SSR time —
	// the dialog doesn't format dates, but the provider scolds on
	// every render unless one is supplied.
	return renderToStaticMarkup(
		<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
			{node}
		</NextIntlClientProvider>,
	);
}

describe("DeleteConfirmDialog", () => {
	it("renders the error message inside the dialog when one is provided", () => {
		const html = render(
			<DeleteConfirmDialog
				busy={false}
				error="Could not delete: storage is offline"
				onCancel={() => {}}
				onConfirm={() => {}}
			/>,
		);
		// The error paragraph must live inside the <dialog> — that's the
		// whole point of the fix. Asserting on `role="alert"` plus the
		// message catches both "rendered nowhere" and "rendered outside
		// the dialog" regressions in a single check.
		expect(html).toContain('role="alert"');
		expect(html).toContain("Could not delete: storage is offline");
		const dialogStart = html.indexOf("<dialog");
		const dialogEnd = html.lastIndexOf("</dialog>");
		const alertIndex = html.indexOf('role="alert"');
		expect(dialogStart).toBeGreaterThanOrEqual(0);
		expect(alertIndex).toBeGreaterThan(dialogStart);
		expect(alertIndex).toBeLessThan(dialogEnd);
	});

	it("omits the alert when no error is supplied", () => {
		const html = render(
			<DeleteConfirmDialog
				busy={false}
				error={null}
				onCancel={() => {}}
				onConfirm={() => {}}
			/>,
		);
		expect(html).not.toContain('role="alert"');
	});
});
