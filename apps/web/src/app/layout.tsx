import "@sse/styles/globals.css";
import "@opfs/design-tokens/tokens.css";

import type { Metadata } from "next";

export const metadata: Metadata = {
	title: "opfs-webauthn",
	description: "Local-first, end-to-end encrypted notes unlocked by a passkey.",
	icons: [{ rel: "icon", url: "/favicon.ico" }],
};

export default function RootLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	);
}
