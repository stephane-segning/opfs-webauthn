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
 */
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
	// `root` and `list` are pure containers; their children are the
	// block-level nodes we want to separate. For everything else (a
	// paragraph, a heading, a list item, a code block) we let
	// `mdast-util-to-string` produce the joined inline text in one shot.
	if (node.type === "root" || node.type === "list") {
		for (const child of children) blockTextSegments(child, out);
		return;
	}
	const text = mdastToString(node, {
		includeImageAlt: false,
		includeHtml: false,
	});
	if (text) out.push(text);
}

export function stripMarkdown(source: string): string {
	if (!source) return "";
	const tree = PLAINTEXT_PROCESSOR.parse(source) as MdastLike;
	const segments: string[] = [];
	blockTextSegments(tree, segments);
	return segments.join(" ").replace(/\s+/g, " ").trim();
}
