/**
 * Single-locale i18n wiring. The app ships English only today (see
 * PRD 02 "Translations in the MVP"), but every user-facing string
 * lives in `messages/en.json` so adding a locale later is a
 * translation pass, not a refactor.
 */

import enMessages from "./messages/en.json";

export const DEFAULT_LOCALE = "en" as const;
export const messages = { en: enMessages } as const;
export type Messages = typeof enMessages;
