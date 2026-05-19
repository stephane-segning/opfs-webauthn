import "../styles/globals.css";
import "@opfs/design-tokens/tokens.css";

import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";

import { DEFAULT_LOCALE, messages } from "../i18n";

export const metadata: Metadata = {
	title: "opfs-webauthn",
	description: "Local-first, end-to-end encrypted notes unlocked by a passkey.",
	icons: [{ rel: "icon", url: "/favicon.ico" }],
};

export default function RootLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang={DEFAULT_LOCALE}>
			<body>
				<NextIntlClientProvider
					locale={DEFAULT_LOCALE}
					messages={messages[DEFAULT_LOCALE]}
					timeZone="UTC"
				>
					{children}
				</NextIntlClientProvider>
			</body>
		</html>
	);
}
