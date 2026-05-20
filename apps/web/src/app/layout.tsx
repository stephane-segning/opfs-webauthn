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
		{ rel: "apple-touch-icon", url: `${BASE_PATH}/apple-touch-icon.png` },
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
			<head>
				{/*
				 * Runtime config: nginx renders `/config.js` from the
				 * pod's env on container start (see
				 * `apps/web/docker/40-render-config.sh`). This script
				 * tag is intentionally **not** `defer`/`async` — it
				 * has to set `window.__OPFS_CONFIG__` before any
				 * bundle script reads it. Next.js auto-defers its own
				 * scripts, so a classic blocking <script> in <head>
				 * lands first regardless of bundle order.
				 *
				 * Static export emits this verbatim into every
				 * generated HTML page; the file itself isn't part of
				 * the build, the container creates it at start.
				 */}
				<script src={`${BASE_PATH}/config.js`} />
			</head>
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
