/**
 * `@opfs/design-tokens` — typed view of the CSS variables shipped in
 * `tokens.css`.
 *
 * Consumers either:
 *   1. Import the stylesheet once: `import "@opfs/design-tokens/tokens.css"`.
 *   2. Reference tokens by name: `color: var(--accent)` in CSS, or use
 *      the `tokens` object below to keep the names typed in TS.
 */

export const tokens = {
	font: {
		ui: "var(--font-ui)",
		body: "var(--font-body)",
		mono: "var(--font-mono)",
	},
	space: {
		1: "var(--space-1)",
		2: "var(--space-2)",
		3: "var(--space-3)",
		4: "var(--space-4)",
		5: "var(--space-5)",
		6: "var(--space-6)",
		7: "var(--space-7)",
		8: "var(--space-8)",
	},
	radius: {
		sm: "var(--radius-sm)",
		md: "var(--radius-md)",
		lg: "var(--radius-lg)",
		pill: "var(--radius-pill)",
	},
	motion: {
		fast: "var(--motion-fast)",
		medium: "var(--motion-medium)",
		slow: "var(--motion-slow)",
	},
	surface: {
		page: "var(--surface-page)",
		panel: "var(--surface-panel)",
		card: "var(--surface-card)",
		overlay: "var(--surface-overlay)",
	},
	border: {
		subtle: "var(--border-subtle)",
		strong: "var(--border-strong)",
	},
	text: {
		primary: "var(--text-primary)",
		secondary: "var(--text-secondary)",
		muted: "var(--text-muted)",
	},
	accent: {
		base: "var(--accent)",
		contrast: "var(--accent-contrast)",
		soft: "var(--accent-soft)",
	},
} as const;

export type ThemeName = "light" | "dark" | "system";

/**
 * Apply `data-theme="dark"` / no attribute (system) / `data-theme="light"`
 * to the document root. Safe to call from a useEffect; no-ops on the
 * server.
 */
export function applyTheme(name: ThemeName): void {
	if (typeof document === "undefined") return;
	if (name === "system") {
		document.documentElement.removeAttribute("data-theme");
	} else {
		document.documentElement.setAttribute("data-theme", name);
	}
}
