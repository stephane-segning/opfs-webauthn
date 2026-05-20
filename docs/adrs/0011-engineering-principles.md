# ADR 0011 — Engineering principles: SOLID, DRY, elegance

- **Status**: Accepted
- **Date**: 2026-05-20

## Context

After several PRs of working code the author asked, in so many words,
that subsequent changes follow SOLID + DRY and **prefer elegance over
expedience**. Up to that point we had been treating the system as a
research vehicle where shipping a working feature was the dominant
concern; from that point onward we hold a higher bar.

The reason this is an ADR and not a style guide is that it is a
deliberate choice with consequences for velocity. Future contributors
should know it was set intentionally, not casually.

## Decision

Every change must satisfy four checks before it lands:

1. **Single responsibility, observable seams.** Each module owns one
   bounded concern. The boundary between modules is a typed surface
   that can be unit-tested in isolation. If a function is doing two
   things (e.g. "talk to KV *and* check a rate limit"), split it; the
   composition lives one layer up.
2. **Open–closed via dispatch tables, not switches with side effects.**
   When you add a new variant of something (a new RPC kind, a new
   error category, a new share-error mapping), prefer a discriminated
   record + a typed table to a `switch` with bodies that do work. The
   tests verify the table shape; the runtime just dispatches.
3. **DRY at the principle layer, not at the keystroke layer.** It's
   fine to have two functions that look superficially similar if they
   answer different questions (e.g. AAD construction for vault rows
   vs. share blobs). The duplication to ruthlessly remove is the one
   that hides a shared invariant — e.g. one place that decides "what
   the AES-GCM AAD includes" vs. five places that each rebuild it.
4. **Elegance is observable.** A change is elegant if a reviewer can
   read the diff and *see* the invariant the code maintains. Long
   comments are not elegance; they are an indictment of names. If the
   code needs a paragraph to explain why a guard exists, the guard's
   name should improve until the paragraph is unnecessary.

### Concrete corollaries

- **No backwards-compatibility hacks for unused options.** We are
  pre-1.0 and the entire codebase is monorepo-internal. If a stub
  option is not consumed anywhere (`grep` is the test), the right
  PR removes it. Carrying it "just in case" is dead weight; codex
  flagged this kind of thing twice in #11 and #15.
- **Best-effort defenses are documented as such.** Rate limits over
  eventually-consistent KV, single-pickup over R2 with conditional
  put — both of these have failure modes the surrounding text should
  call out. Hard enforcement, if needed, lives at a different layer
  (Cloudflare zone WAF, R2's atomic put). The point is not to hide
  the weakness; the point is to name it.
- **Tests cover the invariant, not the implementation.** When codex
  pointed out that the LWW notes-store test would pass even if the
  generation guard misfired (#20), the right fix was to make the
  test actually distinguish stale from fresh — not to add another
  assertion that reinforces the same gap.
- **Failure paths are typed.** A function that can fail returns a
  typed error (`ShareError`, `ShareVaultError`, etc.), never a raw
  `Error` whose message the caller has to sniff. Codex's review on
  #16 surfaced the panic-vs-typed-error trap; we hold the typed-error
  line everywhere now.

## Consequences

- PRs are slower to land because we factor more carefully.
- Reviews are mechanically simpler because each PR has a tighter
  thesis and a smaller diff.
- The cost of the next refactor goes down: a module that owns one
  concern can be lifted into another project (ADR 0010) without
  carrying app-specific tendrils.
- Some "obvious" code shortcuts are explicitly out — e.g. the
  ten-line discriminated union we prefer over a five-line `any`-typed
  envelope.

## Alternatives considered

- **No principle, just shipping.** Faster in the short term; produces
  code that is harder to lift into other projects, harder to review,
  and harder for a future maintainer (us, six months from now) to
  modify safely.
- **A formal style guide / linter rule per item.** Would let CI
  enforce some of this, but most of the principle is about taste
  (when to factor, what to name, where to draw a seam) and the parts
  that can be linted (e.g. typed errors) already are.
