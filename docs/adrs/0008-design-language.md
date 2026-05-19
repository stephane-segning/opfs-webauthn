# ADR 0008 — Design language

- **Status**: Accepted
- **Date**: 2026-05-19

## Context

We need a unified UI across the auth screen, the notes app, and the
share flow. The product is a privacy-first notes app: it should feel
calm, focused, and trustworthy, not loud or playful. We are a small
research team and cannot afford a bespoke design system, but we want
something better than "Tailwind defaults."

Refero references that anchored the direction:

- **Reflect Notes** (`reflect.app`) — dark, contemplative, atmospheric
  notes-tool aesthetic.
- **Signal** (`signal.org`) — calm, privacy-first, friendly-without-being-cute.
- **Obsidian** (`obsidian.md`) — utilitarian, dark, dense without being
  cramped.
- **Skiff** (`skiff.com`) — encrypted-productivity app structure: light
  sidebar, content list, detail pane.
- **Perplexity / mymind** — generous whitespace, editorial restraint for
  the light theme.

## Decision

### Tone

- **Calm, focused, slightly editorial.** No marketing energy in the
  product UI. No gradients in the chrome (a single subtle accent glow on
  the auth screen is allowed).
- **Trust through restraint.** Plain language, no security theater,
  small explanatory copy where it matters (e.g. "this device is your
  only key").

### Modes

- Two themes: **light** (cream-white / charcoal, Signal-inspired) and
  **dark** (near-black with a violet accent, Reflect-inspired). System
  preference is the default; manual override is persisted in OPFS
  metadata so it survives reloads.

### Tokens (initial — refined in `packages/design-tokens`)

- **Accent**: violet `#7C5CFF` (dark) / `#5B3FE0` (light). Used sparingly
  — primary CTA, focus ring, selected note.
- **Surface**: 4 levels — page, panel, card, overlay. Defined as CSS
  variables so themes swap atomically.
- **Type**: Inter (UI), iA Writer Quattro (body / editor). Body type
  optimised for reading long notes.
- **Radius**: 8px default, 12px on cards, full on pills.
- **Shadow**: prefer thin borders over shadows in light mode; faint
  inset glow in dark mode.

### Structural patterns

- **Auth screen**: full-page centered single-card layout. One primary
  button. A small monospaced "v0.x" tag, Imgs.so-style.
- **Notes shell**: three-pane on desktop (rail + list + editor),
  collapsing to two panes on tablet and a single stack with bottom nav
  on mobile.
- **Mobile-first.** Editor, list, and command surfaces must work at 360px
  width and remain pleasant. Desktop is a progressive enhancement.

### Component library

- Headless primitives from **Radix UI**.
- Styled with Tailwind v4 + CSS variables fed by `packages/design-tokens`.
- Exported from `packages/ui` as both styled-by-default and headless
  variants so consumers in other projects can re-skin.

### Accessibility baseline

- WCAG AA contrast minimum on both themes.
- Every interactive element keyboard-reachable; visible focus ring uses
  the accent color.
- `prefers-reduced-motion` respected for any transition over 150ms.

## Consequences

- We can ship a coherent look without a full design system.
- Token-driven theming means light/dark is configuration, not a fork.
- Sharing the UI package into another project requires importing
  `packages/design-tokens` and the Tailwind preset; the package README
  documents this.

## Alternatives considered

- **shadcn/ui** as the base: nice ergonomics but couples us to a
  specific build pattern. We borrow ideas (Radix + Tailwind) without
  copying the entire system.
- **Building our own headless primitives**: too much work for a research
  project.
- **A bespoke design system from scratch**: research budget killer.
