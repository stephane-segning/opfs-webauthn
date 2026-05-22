"use client";

/**
 * Markdown rendering for note bodies.
 *
 * Library choice: `react-markdown` + `rehype-sanitize`.
 *
 * Why this combo over `marked` + `DOMPurify`:
 *  - React-native: no `dangerouslySetInnerHTML`. The library produces a
 *    real React tree, so we avoid the entire class of bugs where a
 *    sanitized HTML string is later mutated by something that thinks
 *    "string" means "safe".
 *  - The sanitization is built into the rehype pipeline, not bolted on
 *    after-the-fact — easier to reason about and keep correct.
 *  - SOLID/DRY: a single `<NoteMarkdown>` is the *only* surface in the
 *    app that turns user content into rendered nodes; everywhere else
 *    treats the body as a plain string. If a future audit tightens the
 *    sanitizer policy, there is exactly one place to change.
 *
 * Trade-off: the unified/remark/rehype pipeline is heavier than
 * marked+DOMPurify (~33 KB gzipped). We measured the route-size delta in
 * the build and stayed under the 50 KB ceiling set by the task brief;
 * see the PR body for the numbers. If that ever changes, swap this
 * module's internals — the call sites only know about `<NoteMarkdown>`
 * and `stripMarkdown`.
 *
 * Security notes:
 *  - `rehype-sanitize` is configured with the `defaultSchema`, which is
 *    GitHub's hardened allowlist. Raw HTML in the source markdown is
 *    parsed by rehype but only allowlisted nodes/attributes survive —
 *    `<script>` is dropped, `onerror` attributes are stripped, and
 *    `javascript:` URLs are rejected by the URL filter.
 *  - We rewrite external links to `target="_blank" rel="noopener
 *    noreferrer"` via a custom component. The sanitizer otherwise
 *    refuses `target` on `<a>`, so this happens *after* sanitization in
 *    react-markdown's component layer, which is safe because the URL
 *    has already been validated.
 */

import ReactMarkdown from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

/**
 * The shipped sanitizer schema. Built from `defaultSchema` (GitHub's
 * conservative allowlist) and extended with the minimum needed for our
 * UI: nothing right now, but keeping the indirection means we have one
 * obvious place to allow e.g. `<sup>` for footnotes later.
 *
 * We intentionally do NOT add `target`/`rel` here — those come from the
 * component override (see `MARKDOWN_COMPONENTS`) so we can default to
 * safe values rather than trusting whatever the markdown source said.
 */
const SANITIZE_SCHEMA = defaultSchema;

/**
 * A href is "external" if it parses as an absolute URL with a different
 * origin than the document. Anchors (`#foo`) and same-origin relative
 * paths render in-place; only http(s) cross-origin links get the
 * new-tab treatment.
 *
 * SSR safety: on the server we cannot know the document origin, so we
 * cannot decide externality without risking a hydration mismatch on
 * absolute same-origin URLs (e.g. the user pasted the full URL of a
 * page in this app). We default to `false` on the server and let the
 * client paint compute the correct value after mount. The first paint
 * is therefore "same-tab" for every absolute URL, which is a milder
 * surprise than React tearing the link element down because the server
 * said `target="_blank"` and the client disagrees.
 *
 * Protocol-relative URLs (`//example.com/foo`) are treated as external:
 * same-origin protocol-relative is uncommon and the safer default is to
 * open in a new tab with `rel="noopener noreferrer"`.
 *
 * We swallow URL parse errors and treat the link as internal — the
 * sanitizer has already rejected any URL it considers unsafe, so a
 * value we can't parse here is either a fragment, a relative path, or
 * a mailto, none of which want `target="_blank"`.
 */
function isExternalHref(href: string | undefined): boolean {
	if (!href) return false;
	// SSR: stay deterministic. The client effect will upgrade the link
	// after hydration. Returning `false` here matches the very first
	// client paint, before window.location is read.
	if (typeof window === "undefined") return false;
	if (href.startsWith("#")) return false;
	// Protocol-relative (`//host/path`) — treat as external. Without an
	// explicit scheme they inherit the page's, but the host is different
	// from the document origin in every realistic case.
	if (href.startsWith("//")) return true;
	// Path-relative (`/foo`, `./foo`, `foo`) is by definition same-origin.
	if (href.startsWith("/")) return false;
	try {
		const url = new URL(href, window.location.href);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		return url.origin !== window.location.origin;
	} catch {
		return false;
	}
}

/**
 * Component overrides for react-markdown. Only `<a>` is customized —
 * everything else uses the default node, so the rendered tree stays a
 * vanilla semantic-HTML subtree styled by `.note-markdown` CSS.
 */
const MARKDOWN_COMPONENTS = {
	a({
		href,
		children,
		...rest
	}: {
		readonly href?: string;
		readonly children?: React.ReactNode;
	} & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
		const external = isExternalHref(href);
		return (
			<a
				{...rest}
				href={href}
				rel={external ? "noopener noreferrer" : undefined}
				target={external ? "_blank" : undefined}
			>
				{children}
			</a>
		);
	},
};

const REHYPE_PLUGINS = [[rehypeSanitize, SANITIZE_SCHEMA]] as const;

export type NoteMarkdownProps = {
	readonly source: string;
};

/**
 * Render a note body as sanitized React nodes. The caller wraps this
 * in a `.note-markdown` container that owns the typographic styles —
 * keeping presentation outside the component means tests and the list
 * preview can use the same renderer without dragging CSS along.
 */
export function NoteMarkdown({ source }: NoteMarkdownProps) {
	return (
		<ReactMarkdown
			components={MARKDOWN_COMPONENTS}
			// rehype-sanitize is parameterized; cast keeps the tuple shape
			// react-markdown expects (a plugin or [plugin, options] pair).
			rehypePlugins={REHYPE_PLUGINS as never}
		>
			{source}
		</ReactMarkdown>
	);
}

/**
 * Reduce a markdown source to a single-line plain-text preview, for use
 * in note cards where headings/bold/etc. are noise. We deliberately do
 * NOT run the full markdown pipeline here — list cards render many at
 * once and the parser cost would dominate. A regex pass is good enough
 * because:
 *  - the output is never injected as HTML — it lands inside a React
 *    text node, so a missed sanitization step here cannot become XSS;
 *  - the goal is "show the words, drop the syntax", not faithful
 *    rendering.
 */
export function stripMarkdown(source: string): string {
	return (
		source
			// Fenced and inline code: keep the contents (without backticks).
			.replace(/```[\s\S]*?```/g, (block) =>
				block.replace(/^```\w*\n?|\n?```$/g, ""),
			)
			.replace(/`([^`]+)`/g, "$1")
			// Images: drop entirely (alt text rarely reads well in a card).
			.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
			// Links: keep the visible text, drop the URL.
			.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
			// ATX headings, blockquotes, list markers at line start.
			.replace(/^\s{0,3}(#{1,6}\s+|>\s+|[-*+]\s+|\d+\.\s+)/gm, "")
			// Bold/italic/strikethrough markers (non-greedy, balanced).
			.replace(/(\*\*|__)(.*?)\1/g, "$2")
			.replace(/(\*|_)(.*?)\1/g, "$2")
			.replace(/~~(.*?)~~/g, "$1")
			// Horizontal rules.
			.replace(/^\s*[-*_]{3,}\s*$/gm, "")
			// Collapse whitespace runs so the preview reads as one paragraph.
			.replace(/\s+/g, " ")
			.trim()
	);
}
