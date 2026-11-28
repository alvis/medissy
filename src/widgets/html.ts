/**
 * the only way Medissy builds HTML for an A2A part: a tagged template that
 * escapes every interpolated value unless it is markup this template itself
 * produced; record text, labels, sources and anything a caller sent are
 * plain strings, so they always reach the page as inert text
 */

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
  '=': '&#61;',
};

/** markup produced by `html`; the one value the template does not escape */
export class SafeHtml {
  readonly #markup: string;

  /** @param markup markup assembled only from escaped values and literals */
  private constructor(markup: string) {
    this.#markup = markup;
  }

  /**
   * wraps markup that `html` assembled; not exported beyond this module's
   * `html` and `join` helpers
   * @param markup the assembled markup
   * @returns the wrapper
   */
  public static fromTemplate(markup: string): SafeHtml {
    return new SafeHtml(markup);
  }

  /**
   * returns the markup this value wraps, which is already safe to embed
   * @returns the markup
   */
  public toString(): string {
    return this.#markup;
  }
}

/** a value `html` accepts in an interpolation */
export type HtmlValue =
  | SafeHtml
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly HtmlValue[];

/**
 * escapes text for an HTML text node or a quoted attribute value; `=` and
 * backtick are escaped too, so a value can never close or open an attribute
 * even if a template forgot its quotes
 * @param text untrusted text
 * @returns the escaped text
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"'`=]/g, (char) => ESCAPES[char] ?? char);
}

/**
 * renders one interpolated value
 * @param value a string to escape, or a `SafeHtml` to embed as is
 * @returns escaped text, or the markup of a `SafeHtml`
 */
function render(value: HtmlValue): string {
  if (value instanceof SafeHtml) {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item: HtmlValue) => render(item)).join('');
  }

  if (value === null || value === undefined || value === false) {
    return '';
  }

  return escapeHtml(String(value));
}

/**
 * builds markup with a tagged template that escapes every interpolation
 * @param literals the template's literal markup
 * @param values the interpolated values
 * @returns the assembled markup
 */
export function html(
  literals: TemplateStringsArray,
  ...values: readonly HtmlValue[]
): SafeHtml {
  let markup = literals[0] ?? '';

  values.forEach((value, index) => {
    markup += render(value) + (literals[index + 1] ?? '');
  });

  return SafeHtml.fromTemplate(markup);
}
