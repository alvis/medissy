/**
 * plain-text hygiene for A2A text parts; a client may render a text part as
 * Markdown (and some echo it to a model that re-renders it), so released
 * values are flattened to one line and every Markdown or HTML control
 * character is backslash-escaped: a record cannot add a link, an image
 * beacon, raw HTML or a code fence to the chat
 */

/** longest line, in characters, before `inertLine` adds an ellipsis */
const DEFAULT_LINE_MAX = 300;
/** control, format (bidi overrides) and separator characters */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
/** characters with Markdown or HTML meaning in common chat renderers */
const MARKDOWN_ACTIVE = /[\\`*_{}[\]()<>#!|~]/g;

/**
 * flattens untrusted text to one inert Markdown line
 * @param value untrusted text
 * @param max the longest result, in characters, before an ellipsis
 * @returns one line with Markdown control characters escaped
 */
export function inertLine(value: string, max = DEFAULT_LINE_MAX): string {
  const flat = value.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  const cut = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;

  return cut.replace(MARKDOWN_ACTIVE, (char) => `\\${char}`);
}

/**
 * flattens untrusted text to one line without escaping, for places that are
 * never rendered as Markdown or HTML (the sign-in context, log-free labels)
 * @param value untrusted text
 * @param max the longest result, in characters, before an ellipsis
 * @returns one line without control or format characters
 */
export function oneLine(value: string, max: number): string {
  const flat = value.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
