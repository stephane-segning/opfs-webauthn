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

import { toString as mdastToString } from "mdast-util-to-string";
import ReactMarkdown from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkParse from "remark-parse";
import { unified } from "unified";

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
 * A href is "external" if its syntactic shape is an absolute URL —
 * `http://…`, `https://…`, or protocol-relative `//host/…`. Anchors
 * (`#foo`) and path-relative URLs (`/foo`, `./foo`, `foo`) stay
 * in-place.
 *
 * SSR-determinism contract: this function MUST return the same value
 * on the server and on the client. The previous implementation branched
 * on `typeof window`, which made absolute same-origin URLs internal on
 * the server and (sometimes) external on the client — React treated
 * that as a hydration mismatch and would recover by tearing down and
 * rebuilding the link subtree.
 *
 * The trade-off: we no longer compare against `window.location.origin`,
 * so an absolute URL that happens to match this app's origin (e.g. the
 * user pasted the full deployed URL of a page in this app) will get
 * `target="_blank"` instead of opening in the same tab. That is a
 * UX-acceptable false positive: the link still works, the user just
 * ends up in a new tab. The alternative — a useEffect-driven upgrade —
 * would jitter the link's target attribute right after first paint,
 * which is the worse outcome.
 *
 * Protocol-relative URLs (`//example.com/foo`) are also treated as
 * external. They inherit the page protocol but the host is different
 * from the document origin in every realistic case, and the safer
 * default is the new-tab behaviour with `rel="noopener noreferrer"`.
 */
function isExternalHref(href: string | undefined): boolean {
	if (!href) return false;
	// Same-document anchor — never external.
	if (href.startsWith("#")) return false;
	// Protocol-relative (`//host/path`).
	if (href.startsWith("//")) return true;
	// Path-relative (`/foo`, `./foo`, `../foo`, `foo`) — same-origin.
	if (href.startsWith("/") || href.startsWith(".")) return false;
	// Absolute http(s). Other schemes (mailto:, tel:, javascript: — the
	// last of which the sanitizer already strips) are not "external" in
	// the new-tab sense.
	return /^https?:\/\//i.test(href);
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
		// `react-markdown` passes the mdast/hast node as a `node` prop to
		// custom renderers. It is not a valid DOM attribute, so we destructure
		// it out before spreading the rest onto the <a> element — otherwise
		// React logs "Unknown prop `node` on <a> tag" in development.
		node: _node,
		...rest
	}: {
		readonly href?: string;
		readonly children?: React.ReactNode;
		readonly node?: unknown;
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
 * in note cards where headings/bold/etc. are noise.
 *
 * Why a real parser and not a regex pass: an earlier version of this
 * helper used regex to strip `*…*` / `_…_` emphasis markers. That
 * mis-fires on perfectly normal prose — `snake_case_identifier` lost
 * its underscores, `2 * 3 * 4` lost its asterisks, and any text that
 * happened to contain two of those characters became gibberish. The
 * correct fix is to ask the markdown parser whether a span is actually
 * emphasis. We use the same `unified` + `remark-parse` pipeline that
 * `react-markdown` already loads for the preview renderer, then walk
 * the mdast tree with `mdast-util-to-string`, which by design returns
 * the visible text content of every node — emphasis is unwrapped,
 * literal underscores in code/text stay literal.
 *
 * The result is also dropped into a React text node, never re-injected
 * as HTML, so a missed escape here cannot become XSS.
 */
const PLAINTEXT_PROCESSOR = unified().use(remarkParse);

// Minimal mdast node shape we care about — `mdast-util-to-string` and
// `unified.parse` are loosely typed at the boundary, so we model only
// the fields we read.
type MdastLike = {
	readonly type: string;
	readonly children?: readonly MdastLike[];
};

/**
 * Walk the parsed tree and join the visible text of each block-level
 * node with a space, so adjacent paragraphs / list items / code blocks
 * don't get smashed together (`mdast-util-to-string` concatenates with
 * no separator). For inline nodes we fall through to the default
 * stringifier — that correctly returns `snake_case` and `2 * 3 * 4`
 * verbatim because emphasis is decided by the parser, not by regex.
 *
 * The container set covers every mdast node whose children are
 * themselves block-level: `root` holds the document's top-level blocks,
 * `list` holds list items, and `listItem` / `blockquote` each hold one
 * or more paragraphs (and possibly nested lists). If we stopped at
 * `root`/`list`, calling `mdastToString` on a `listItem` would smash
 * its child paragraphs together with no separator — so e.g. a list of
 * two items "foo bar" / "baz qux" became "foo barbaz qux", and a
 * blockquote with two paragraphs ran them together. Walking into these
 * containers and joining with the same `" "` separator the top-level
 * loop uses keeps multi-block content readable.
 */
const BLOCK_CONTAINER_TYPES = new Set([
	"root",
	"list",
	"listItem",
	"blockquote",
]);

function blockTextSegments(node: MdastLike, out: string[]): void {
	const children = node.children;
	if (!children || children.length === 0) {
		const text = mdastToString(node, {
			includeImageAlt: false,
			includeHtml: false,
		});
		if (text) out.push(text);
		return;
	}
	// Pure block containers: recurse so each block child becomes its own
	// segment, separated by the join below. For leaf block nodes (a
	// paragraph, a heading, a code block) we let `mdast-util-to-string`
	// produce the joined inline text in one shot.
	if (BLOCK_CONTAINER_TYPES.has(node.type)) {
		for (const child of children) blockTextSegments(child, out);
		return;
	}
	const text = mdastToString(node, {
		includeImageAlt: false,
		includeHtml: false,
	});
	if (text) out.push(text);
}

/**
 * LRU cache for `stripMarkdown` results, keyed by the input source.
 *
 * Why this exists: `note-card` calls `stripMarkdown` twice per visible
 * card (title + excerpt) on every re-render, and the notes list
 * re-renders on every keystroke in the search box. Each call runs the
 * full unified/remark-parse pipeline, which is the heaviest piece of
 * the markdown stack. Dozens of cards * two parses * a keystroke per
 * frame thrashes the parser; the typed text and the rendered cards
 * are both stable strings, so we get an excellent hit rate from a
 * straight identity cache.
 *
 * Why a Map and not a WeakMap: keys are strings (the source body).
 * Why an LRU cap: notes can be long and there is no upper bound on
 * how many distinct bodies a session sees, so we cap to keep memory
 * predictable. 200 entries comfortably covers the visible window of
 * cards plus the currently-open note's title/body, with headroom for
 * scroll churn. Insertion-order iteration on `Map` makes the oldest
 * key the first one returned by `keys().next()`, so eviction is O(1).
 */
const STRIP_CACHE = new Map<string, string>();
// why: bound the cache so a long session that touches many distinct
// note bodies cannot grow the heap unboundedly. 200 entries is well
// above any realistic on-screen-cards-plus-open-note working set.
const STRIP_CACHE_CAP = 200;

// Parse invocation counter — incremented every time we actually hit the
// unified pipeline. Tests assert this stays at 1 across repeated calls
// with the same input, which is the load-bearing property of the cache.
// Production code never reads this; it costs one integer increment per
// cache miss.
let stripParseCalls = 0;

function stripMarkdownUncached(source: string): string {
	stripParseCalls += 1;
	const tree = PLAINTEXT_PROCESSOR.parse(source) as MdastLike;
	const segments: string[] = [];
	blockTextSegments(tree, segments);
	return segments.join(" ").replace(/\s+/g, " ").trim();
}

export function stripMarkdown(source: string): string {
	if (!source) return "";
	const cached = STRIP_CACHE.get(source);
	if (cached !== undefined) {
		// LRU bump: re-insert so this key moves to the most-recent slot.
		STRIP_CACHE.delete(source);
		STRIP_CACHE.set(source, cached);
		return cached;
	}
	const result = stripMarkdownUncached(source);
	STRIP_CACHE.set(source, result);
	if (STRIP_CACHE.size > STRIP_CACHE_CAP) {
		// Evict the oldest entry (Map iterates in insertion order).
		const oldest = STRIP_CACHE.keys().next().value;
		if (oldest !== undefined) STRIP_CACHE.delete(oldest);
	}
	return result;
}

/**
 * Test-only: clear the strip cache. Exported so tests that spy on
 * `unified().parse(...)` or assert cache behaviour can start from a
 * known-empty state. Not part of the public surface — call sites in
 * the app never need to invalidate the cache because cached values
 * are pure functions of the input string.
 */
export function __resetStripMarkdownCacheForTests(): void {
	STRIP_CACHE.clear();
	stripParseCalls = 0;
}

/**
 * Test-only: number of times the unified parse pipeline has been
 * invoked since the last cache reset. The cache is correct iff this
 * counter equals the number of *distinct* inputs seen (capped at
 * STRIP_CACHE_CAP per eviction wave).
 */
export function __getStripMarkdownParseCallsForTests(): number {
	return stripParseCalls;
}
