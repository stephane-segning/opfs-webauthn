# @opfs/ui

React components for opfs-webauthn: the auth screen, the notes shell,
small primitives (button, card, dialog), all styled from
[`@opfs/design-tokens`](../design-tokens).

## Status

Stub. Exports `AuthScreenProps` and `NotesShellProps` so the Next.js
app can wire its routes; components themselves land with the UI
implementation PR.

## Reuse

Designed to be importable as either styled defaults or headless
primitives. Consumers in other apps:

```tsx
import "@opfs/design-tokens/tokens.css";
import { AuthScreen } from "@opfs/ui";

<AuthScreen state="locked" onEnroll={...} onUnlock={...} />
```
