/**
 * Markdown rendering and sanitization tests.
 *
 * We render through `react-dom/server`'s `renderToStaticMarkup` rather
 * than `@testing-library/react` + jsdom, because all we need is the
 * *output* of the pipeline (a sanitized HTML string). The server
 * renderer is pure Node, has no global state, and exercises exactly
 * the same component code the browser will run.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
	__getStripMarkdownParseCallsForTests,
	__resetStripMarkdownCacheForTests,
	NoteMarkdown,
	stripMarkdown,
} from "./markdown";

function render(source: string): string {
	return renderToStaticMarkup(<NoteMarkdown source={source} />);
}

describe("NoteMarkdown", () => {
	it("renders a heading as a real <h1>", () => {
		const out = render("# Hello");
		expect(out).toContain("<h1>Hello</h1>");
	});

	it("renders a bullet list", () => {
		const out = render("- one\n- two\n- three");
		expect(out).toContain("<ul>");
		expect(out).toContain("<li>one</li>");
		expect(out).toContain("<li>two</li>");
		expect(out).toContain("<li>three</li>");
	});

	it("renders a code block", () => {
		const out = render("```\nlet x = 1\n```");
		expect(out).toContain("<pre>");
		expect(out).toContain("<code");
		expect(out).toContain("let x = 1");
	});

	it("renders inline code", () => {
		const out = render("use `tabs` not spaces");
		expect(out).toContain("<code>tabs</code>");
	});

	it("adds target=_blank and rel=noopener to external links", () => {
		const out = render("[anthropic](https://anthropic.com)");
		expect(out).toContain('href="https://anthropic.com"');
		expect(out).toContain('target="_blank"');
		expect(out).toContain('rel="noopener noreferrer"');
	});

	it("does not open path-relative links in a new tab", () => {
		// Path-relative URLs are by definition same-origin, so they should
		// open in the same tab regardless of where the page is mounted.
		const out = render("[home](/notes)");
		expect(out).not.toContain('target="_blank"');
	});

	it("treats protocol-relative URLs as external", () => {
		// `//example.com/foo` inherits the page protocol but points to a
		// different host than any realistic same-origin location. The
		// safer default — and the one the security review on PR #48
		// asked for — is to open in a new tab with the noopener rel.
		const out = render("[ext](//example.com/foo)");
		expect(out).toContain('target="_blank"');
		expect(out).toContain('rel="noopener noreferrer"');
	});

	it("renders identically on the server and the client (no hydration drift)", () => {
		// `isExternalHref` is intentionally `window`-independent: the
		// server and the client must produce byte-identical markup, or
		// React will tear down the link subtree on hydration. We assert
		// that property by running the renderer with and without `window`
		// for an absolute URL — both must match.
		const original = globalThis.window;
		try {
			// Server: no window.
			(globalThis as { window?: unknown }).window = undefined;
			const ssr = renderToStaticMarkup(
				<NoteMarkdown source="[home](https://app.example/notes)" />,
			);

			// Client: window with a same-origin location. Even though the
			// URL is same-origin, we (now) classify it as external because
			// we no longer compare against `window.location.origin` — that
			// branch is what caused the hydration mismatch.
			(
				globalThis as {
					window?: { location: { href: string; origin: string } };
				}
			).window = {
				location: {
					href: "https://app.example/",
					origin: "https://app.example",
				},
			};
			const csr = renderToStaticMarkup(
				<NoteMarkdown source="[home](https://app.example/notes)" />,
			);

			expect(ssr).toBe(csr);
		} finally {
			(globalThis as { window?: unknown }).window = original;
		}
	});

	it("emits target=_blank during SSR for absolute URLs (deterministic)", () => {
		// The previous implementation suppressed `target` on SSR and
		// added it on the client, which caused a hydration mismatch. The
		// fix is to always classify absolute URLs as external regardless
		// of where we are running. This test pins that contract.
		const original = globalThis.window;
		try {
			(globalThis as { window?: unknown }).window = undefined;
			const out = renderToStaticMarkup(
				<NoteMarkdown source="[ext](https://anthropic.com)" />,
			);
			expect(out).toContain('target="_blank"');
			expect(out).toContain('rel="noopener noreferrer"');
		} finally {
			(globalThis as { window?: unknown }).window = original;
		}
	});

	it("does not forward the react-markdown `node` prop to the DOM", () => {
		// react-markdown passes an internal mdast/hast `node` to custom
		// renderers. The link override must strip it out — otherwise React
		// warns "Unknown prop `node` on <a>" and the literal string
		// `node="…"` ends up serialized into the HTML.
		const out = render("[anthropic](https://anthropic.com)");
		expect(out).not.toContain("node=");
	});

	it("does not run <script> in the source — the tag is dropped", () => {
		const out = render("hello <script>alert(1)</script> world");
		// The sanitizer strips the script element entirely. The text
		// content inside the tags may survive as plain text — that's
		// fine, plain text in a React node cannot execute. What matters
		// is that no `<script>` tag exists in the rendered HTML to be
		// re-parsed by the browser.
		expect(out).not.toContain("<script");
		expect(out).not.toContain("</script>");
	});

	it("strips event-handler attributes (onerror, onclick, …)", () => {
		const out = render('<img src="x" onerror="alert(1)" alt="x">');
		expect(out).not.toMatch(/onerror/i);
		expect(out).not.toMatch(/alert\(1\)/);
	});

	it("blocks javascript: URLs on links", () => {
		// Markdown syntax with a javascript: href — the sanitizer should
		// strip the href so the link cannot execute the URL.
		const out = render("[click](javascript:alert(1))");
		expect(out).not.toMatch(/href="javascript:/i);
		expect(out).not.toMatch(/alert\(1\)/);
	});

	it("renders plain paragraphs without injecting raw HTML", () => {
		const out = render("a paragraph with **bold** text");
		expect(out).toContain("<strong>bold</strong>");
		expect(out).toContain("a paragraph with");
	});
});

describe("stripMarkdown", () => {
	it("removes heading markers", () => {
		expect(stripMarkdown("# Title")).toBe("Title");
		expect(stripMarkdown("### Deep")).toBe("Deep");
	});

	it("removes bullet list markers but keeps content", () => {
		expect(stripMarkdown("- one\n- two")).toBe("one two");
	});

	it("removes bold and italic markers", () => {
		expect(stripMarkdown("**bold** and *italic* and _under_")).toBe(
			"bold and italic and under",
		);
	});

	it("preserves literal underscores inside identifiers (snake_case)", () => {
		// The regex-based stripper used to eat the underscores in
		// `snake_case_identifier` because it treated any `_…_` span as
		// emphasis. The parser knows better — emphasis requires word
		// boundaries, and a continuous identifier doesn't qualify.
		expect(stripMarkdown("snake_case_identifier")).toBe(
			"snake_case_identifier",
		);
	});

	it("preserves literal asterisks used as multiplication", () => {
		// Same failure mode: `2 * 3 * 4` was previously rewritten to
		// `2 3 4` because the regex matched `* 3 *` as italic. CommonMark
		// requires emphasis delimiters to flank a non-space character, so
		// the parser leaves these alone.
		expect(stripMarkdown("2 * 3 * 4")).toBe("2 * 3 * 4");
	});

	it("unwraps real emphasis even when the surrounding text looks code-like", () => {
		// Mirror image of the previous two: where the markers really are
		// emphasis, we must still strip them. Each input here is the
		// minimal case for a span the parser will recognize.
		expect(stripMarkdown("**bold**")).toBe("bold");
		expect(stripMarkdown("*italic*")).toBe("italic");
		expect(stripMarkdown("_underscore_")).toBe("underscore");
	});

	it("keeps link text, drops the URL", () => {
		expect(stripMarkdown("see [anthropic](https://anthropic.com)")).toBe(
			"see anthropic",
		);
	});

	it("drops images entirely", () => {
		expect(stripMarkdown("before ![alt](x.png) after")).toBe("before after");
	});

	it("keeps inline code contents", () => {
		expect(stripMarkdown("use `npm test`")).toBe("use npm test");
	});

	it("keeps fenced code block contents on one line", () => {
		expect(stripMarkdown("intro\n```\nlet x = 1\n```\nouttro")).toBe(
			"intro let x = 1 outtro",
		);
	});

	it("returns an empty string for an empty input", () => {
		expect(stripMarkdown("")).toBe("");
		expect(stripMarkdown("   \n   ")).toBe("");
	});

	it("separates blocks inside list items and blockquotes (regression)", () => {
		// Before the block-container fix, `mdastToString` concatenated a
		// list item's child paragraphs with no separator, so a two-item
		// list rendered as one smashed-together word, and a blockquote
		// with two paragraphs lost the boundary between them. The fix
		// recognises `listItem` and `blockquote` as block containers so
		// each child block gets the same `" "` separator the top-level
		// loop uses.
		expect(stripMarkdown("- foo bar\n- baz qux")).toBe("foo bar baz qux");
		expect(stripMarkdown("> hello\n>\n> world")).toBe("hello world");
		// The full bar from the task brief: lists and blockquotes mixed
		// in one document must collapse to single-spaced text.
		expect(stripMarkdown("- alpha\n- beta\n\n> hello\n> world")).toBe(
			"alpha beta hello world",
		);
	});
});

describe("stripMarkdown caching", () => {
	it("only parses the source once for repeated identical inputs", () => {
		// The cache is the load-bearing fix for the per-keystroke
		// re-render thrash in `note-card`: two `stripMarkdown` calls per
		// visible card per keystroke runs the unified pipeline dozens of
		// times per frame without it. We assert the property directly
		// via the parse-call counter — 1000 calls with the same input
		// must hit the parser exactly once.
		__resetStripMarkdownCacheForTests();
		const SAME_INPUT = "# Title\n\nBody with **bold** and a [link](/x).";
		for (let i = 0; i < 1000; i += 1) stripMarkdown(SAME_INPUT);
		expect(__getStripMarkdownParseCallsForTests()).toBe(1);
	});

	it("parses each distinct input at most once", () => {
		__resetStripMarkdownCacheForTests();
		const inputs = ["# one", "# two", "# three"];
		// Three distinct inputs, each repeated ten times → three parses.
		for (let i = 0; i < 10; i += 1) {
			for (const input of inputs) stripMarkdown(input);
		}
		expect(__getStripMarkdownParseCallsForTests()).toBe(inputs.length);
	});

	it("returns the same value cached or uncached", () => {
		__resetStripMarkdownCacheForTests();
		const input = "- a\n- b\n\n> c\n> d";
		const first = stripMarkdown(input);
		const second = stripMarkdown(input);
		expect(second).toBe(first);
		expect(__getStripMarkdownParseCallsForTests()).toBe(1);
	});
});
