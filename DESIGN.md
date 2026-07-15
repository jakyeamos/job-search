# Daily Career Queue Design

## Direction

Quiet, practical product UI for a morning review. The surface should feel like a well-made personal tool: clear hierarchy, modest density, direct actions, and no motivational pressure.

## Color tokens

- `--bg`: cool green-gray off-white, the resting page surface.
- `--surface`: near-white content surface.
- `--surface-soft`: lightly tinted neutral for tags and secondary controls.
- `--ink`: deep blue-charcoal for primary text.
- `--ink-soft`: readable secondary text.
- `--ink-faint`: metadata and supporting labels.
- `--line`: quiet separators.
- `--line-strong`: control and section boundaries.
- `--accent`: restrained sage-teal for primary actions and active state.
- `--warning`: amber for roles that need review.
- `--danger`: red reserved for skip/error affordances.

All colors are expressed in OKLCH in `queue-ui/styles.css` and should preserve WCAG AA contrast for text and controls.

## Typography

System UI sans stack. A compact product scale keeps the queue readable at normal desktop density: 13px metadata, 15px body, 18px role titles, 22px section headings, and 52px page heading. The page heading is the only display-like scale.

## Layout

- Top bar: identity, local connection state, and one refresh action.
- Intro: one sentence of orientation plus a restrained three-value summary strip.
- Toolbar: status filters and lane selector.
- Queue: ranked rows with evidence, progressive detail, and actions.
- Quiet boundary note: reinforces human approval without adding another dashboard panel.

The queue is a list, not a grid of identical cards. Rows collapse to two columns on tablet and a single readable stack on mobile.

## Interaction states

Every action exposes hover, focus, active, disabled, loading, and error behavior. Opening a role is a normal external link and does not mutate state. Applied, skipped, and snoozed are explicit mutations with an inline toast confirmation. Snooze uses the native date dialog.

## Motion and accessibility

Motion is limited to short state transitions and toast feedback. `prefers-reduced-motion` disables transition choreography. Focus outlines are visible, status is communicated with text and color, and the UI remains usable without hover.
