# Task: unwrap a callout back into plain text

The plugin can already wrap a selection in a callout (`toCallout` in
`src/callout.ts`, command `wrap-selection`). Add the reverse.

## Requirements

1. In `src/callout.ts`, export `fromCallout(text: string): string`.
   - The first line is a callout header: `>` then optional spaces, then
     `[!type]` where type is any non-empty text without `]`
     (not limited to `CALLOUT_TYPES`), then an optional fold marker `+` or `-`
     directly after the `]`, then an optional title.
   - If the header has a title, the trimmed title is the first output line.
   - Each following line has its quote prefix removed: a leading `> ` (with
     one space) or a lone leading `>`. A line that is exactly `>` becomes an
     empty line.
   - Windows line endings (`\r\n`) are treated as `\n`; output uses `\n`.
   - If the first line is not a callout header, return the input unchanged.
   - A header with no title and no body returns an empty string.
   - Round trip: `fromCallout(toCallout(x, t)) === x` for any `x` without
     `\r` and without trailing newlines.
2. Register an editor command with id `unwrap-selection` and name
   `Unwrap callout in selection` that replaces the selection with
   `fromCallout(selection)`.
3. Keep the existing `wrap-selection` command working.

## Examples

| Input | Output |
|---|---|
| `> [!note]\n> hello` | `hello` |
| `> [!tip] Heads up\n> x` | `Heads up\nx` |
| `> [!faq]- Folded\n> body` | `Folded\nbody` |
| `> [!info]\n> a\n>\n> b` | `a\n\nb` |
| `just text` | `just text` |
