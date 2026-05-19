import "../styles/globals.css";
import "@opfs/design-tokens/tokens.css";

import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";

import { DEFAULT_LOCALE, messages } from "../i18n";
import { ServiceWorkerRegistration } from "./service-worker-registration";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const metadata: Metadata = {
	title: "opfs-webauthn",
	description: "Local-first, end-to-end encrypted notes unlocked by a passkey.",
	manifest: `${BASE_PATH}/manifest.webmanifest`,
	icons: [
		{ rel: "icon", url: `${BASE_PATH}/favicon.ico` },
		{ rel: "icon", url: `${BASE_PATH}/icon.svg`, type: "image/svg+xml" },
		{ rel: "apple-touch-icon", url: `${BASE_PATH}/icon.svg` },
	],
	applicationName: "opfs-webauthn",
	appleWebApp: {
		capable: true,
		title: "opfs",
		statusBarStyle: "black-translucent",
	},
};

export const viewport: Viewport = {
	themeColor: "#0c0c10",
	width: "device-width",
	initialScale: 1,
	viewportFit: "cover",
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
				<ServiceWorkerRegistration />
			</body>
		</html>
	);
}
