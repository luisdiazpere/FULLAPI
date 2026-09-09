/** Strip control characters, collapse whitespace, trim, truncate. */
export function clean(text: string, max: number): string {
  return text
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Fill {placeholders} from vars. A placeholder with no value (or an empty one)
 * is reported in `missing` instead of rendering as a blank or a literal brace.
 */
export function render(
  template: string,
  vars: Record<string, string | null | undefined>,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = vars[key];
    if (!value) {
      missing.push(key);
      return '';
    }
    return value;
  });
  return { text, missing: [...new Set(missing)] };
}

/** Only plain https URLs reach Stripe. Blocks data:, javascript:, and credentialed URLs. */
export function httpsImage(url: string): string | null {
  if (url.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  return parsed.toString();
}
