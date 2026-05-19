# PRD 02 — Non-goals

These are things we explicitly do not build, at least until the MVP is
shipped and the research questions it answers are written up. They are
listed here so that future PRs can be rejected with a single link instead
of a debate.

## Not building

- **Password / email accounts.** The passkey is the only credential. No
  fallback authentication path.
- **Account recovery.** If the user loses every device with the enrolled
  passkey, the local vault on those devices is unrecoverable. We document
  this clearly in onboarding.
- **Server-side notes storage.** The backend exists only to relay an
  encrypted blob from one device to another for the share flow. It does
  not retain notes.
- **Real-time multi-device sync.** Sharing is a one-shot "send this note
  to my other device" action, not a continuous replication channel.
- **Multi-user collaboration.** A note belongs to one vault.
- **Rich-text editor.** Markdown only for the MVP. No tables, no embedded
  images, no slash commands.
- **Attachments / files.** Text content only.
- **Folders, tags, search filters, pinned notes.** Flat list + full-text
  search.
- **Native mobile apps.** PWA is the only shipped surface.
- **Browser support outside the WebAuthn-PRF set.** We require a browser
  that supports the PRF extension. We show a clear unsupported message
  elsewhere and do not attempt to polyfill.
- **Translations in the MVP.** English copy only. But user-facing
  strings are externalised into `next-intl` message files from day one
  so adding a locale later is a translation pass, not a refactor. The
  non-goal is "ship more than one locale", not "wire up the i18n
  toolchain".

## Deferred (likely yes, but not now)

- Export / import a vault as an encrypted file.
- Browser-to-browser passkey portability via the platform's native
  syncing (iCloud Keychain, Google Password Manager). We will document
  what we observe, but design for the "passkey is per-device" worst case.
- A simple conflict-resolution UI for shared notes.
