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

import { NoteMarkdown, stripMarkdown } from "./markdown";

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
		// We pin the renderer to a fixed origin so URL.origin comparison
		// in the component is deterministic in tests.
		const original = globalThis.window;
		// jsdom isn't loaded; emulate the minimal shape react-markdown's
		// link override reads (`window.location.href`).
		(
			globalThis as { window?: { location: { href: string; origin: string } } }
		).window = {
			location: {
				href: "https://app.example/",
				origin: "https://app.example",
			},
		};
		try {
			const out = render("[anthropic](https://anthropic.com)");
			expect(out).toContain('href="https://anthropic.com"');
			expect(out).toContain('target="_blank"');
			expect(out).toContain('rel="noopener noreferrer"');
		} finally {
			(globalThis as { window?: unknown }).window = original;
		}
	});

	it("does not open same-origin links in a new tab", () => {
		const original = globalThis.window;
		(
			globalThis as { window?: { location: { href: string; origin: string } } }
		).window = {
			location: {
				href: "https://app.example/",
				origin: "https://app.example",
			},
		};
		try {
			const out = render("[home](https://app.example/notes)");
			expect(out).not.toContain('target="_blank"');
		} finally {
			(globalThis as { window?: unknown }).window = original;
		}
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
});
