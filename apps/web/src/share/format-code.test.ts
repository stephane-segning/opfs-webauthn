import { describe, expect, it } from "vitest";

import { formatCodeForDisplay } from "./format-code";

describe("formatCodeForDisplay", () => {
	it("groups a 12-character code into three blocks of four", () => {
		expect(formatCodeForDisplay("ABCDEFGHJKMN")).toBe("ABCD-EFGH-JKMN");
	});

	it("handles a shorter string without padding", () => {
		expect(formatCodeForDisplay("ABCD")).toBe("ABCD");
	});

	it("handles an empty string", () => {
		expect(formatCodeForDisplay("")).toBe("");
	});
});
