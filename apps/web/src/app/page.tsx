import { version } from "../../package.json";

export default function Home() {
	return (
		<main className="auth-screen">
			<section className="auth-card">
				<header>
					<p className="auth-tag">opfs-webauthn · v{version}</p>
					<h1>Your notes, locked to a passkey.</h1>
					<p className="auth-blurb">
						Everything stays on this device. The only way in is the passkey you
						create — no email, no password, no recovery codes.
					</p>
				</header>
				<button className="auth-cta" disabled type="button">
					Create encrypted vault
				</button>
				<p className="auth-foot">
					Enrollment goes live with the WebAuthn flow PR.
				</p>
			</section>
		</main>
	);
}
