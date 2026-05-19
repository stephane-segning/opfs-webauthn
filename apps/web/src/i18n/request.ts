import { getRequestConfig } from "next-intl/server";

import { DEFAULT_LOCALE, messages } from "./index";

/**
 * Single-locale `getRequestConfig` so next-intl's server runtime (which
 * fires even for static-export builds rendering things like the
 * `_not-found` page) finds the same messages the client provider uses.
 * PRD 02 commits us to English only, but the wiring is in place so a
 * future locale-switch is a translation pass, not a refactor.
 */
export default getRequestConfig(async () => ({
	locale: DEFAULT_LOCALE,
	messages: messages[DEFAULT_LOCALE],
	timeZone: "UTC",
}));
