import { clsx, type ClassValue } from 'clsx';

/** Tailwind class combiner used across the design system. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * A file size in the unit that makes it readable.
 *
 * The documents screen shows both a stored document's size and the server's
 * upload limit, and a limit printed as `10485760` next to a file printed as
 * `2.4 MB` is a comparison nobody can actually make.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value < 10 ? 1 : 0)} ${BYTE_UNITS[exponent]}`;
}

/**
 * Copies text and reports whether it worked.
 *
 * `navigator.clipboard` is undefined outside a secure context, so a caller that
 * resolved unconditionally would tell the user "Copied" on an HTTP deployment
 * where nothing was written. Returning the outcome lets the toast say which
 * happened.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
