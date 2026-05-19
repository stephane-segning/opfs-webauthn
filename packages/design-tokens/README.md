# @opfs/design-tokens

CSS variables and a typed token object for the opfs-webauthn UI. Calm,
minimal, single accent. Light is default; dark flips automatically via
`prefers-color-scheme` or explicitly via `data-theme="dark"` on the
`<html>` root.

See [ADR 0008](../../docs/adrs/0008-design-language.md) for the
underlying language.

## Use in another app

```ts
import "@opfs/design-tokens/tokens.css";
import { tokens, applyTheme } from "@opfs/design-tokens";

applyTheme("system"); // or "light" / "dark"
```

```css
.button {
	background: var(--accent);
	color: var(--accent-contrast);
	border-radius: var(--radius-md);
	transition: background var(--motion-medium);
}
```

## What ships

- Token CSS variables: type families, 8-step spacing scale, 4 radii,
  3-stop motion scale, 4-level surface ladder, 2-level border, 3
  text levels, accent (base + contrast + soft), focus ring.
- Light + dark themes; `prefers-reduced-motion` zeroes the motion scale.
- A typed `tokens` object so TS callers don't sprinkle string
  references to `var(--x)`.

## What doesn't

This package does not own components or Tailwind config; those live in
[`@opfs/ui`](../ui). It also doesn't ship a JS theme switcher beyond
the imperative `applyTheme` helper.
