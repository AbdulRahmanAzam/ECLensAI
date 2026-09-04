/**
 * Transport for the v1 API.
 *
 * The session is an httpOnly cookie, so every request carries credentials and no
 * token is ever visible to the page. Errors arrive on one envelope
 * (`{ error: { code, message, requestId?, details? } }`); `ApiError` preserves it
 * so a caller can branch on `code` — `RUN_LOCKED`, `FORBIDDEN`,
 * `RUN_SELF_APPROVAL_PROHIBITED` — instead of parsing a message string.
 */
import type { ApiErrorBody } from '@eclens/shared';

export const API_BASE = import.meta.env.VITE_API_BASE ?? '/api/v1';

export interface ApiErrorDetail {
  path?: string;
  field?: string;
  message?: string;
  observed?: string;
  expected?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly details?: ApiErrorDetail[];

  constructor(status: number, body: ApiErrorBody['error']) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.requestId = body.requestId;
    this.details = body.details;
  }

  /** A 401 means the cookie expired; callers redirect rather than render a toast. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  /** Field-level messages for a form, keyed by the path the validator reported. */
  fieldMessages(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const detail of this.details ?? []) {
      const key = detail.field ?? detail.path;
      if (key && detail.message) out[key] = detail.message;
    }
    return out;
  }
}

/** Query params are dropped when empty so `?stage=&search=` never reaches the API. */
export function toQueryString(params: Record<string, unknown> | undefined): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: ApiErrorBody | undefined;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = undefined;
  }
  const error = body?.error;
  return new ApiError(
    response.status,
    error ?? {
      code: `HTTP_${response.status}`,
      message: response.statusText || 'The request failed.',
    },
  );
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** A JSON body. `FormData` is passed through untouched so multer sees the file. */
  body?: unknown;
  query?: Record<string, unknown>;
  signal?: AbortSignal;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal } = options;
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;

  const headers: Record<string, string> = {};
  if (body !== undefined && !isFormData) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${API_BASE}${path}${toQueryString(query)}`, {
    method,
    headers,
    credentials: 'include',
    signal,
    body: body === undefined ? undefined : isFormData ? (body as FormData) : JSON.stringify(body),
  });

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Downloads a binary or text attachment without the JSON envelope. */
export async function downloadText(path: string, query?: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${API_BASE}${path}${toQueryString(query)}`, {
    credentials: 'include',
  });
  if (!response.ok) throw await toApiError(response);
  return response.text();
}

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * Turns a base64 payload into a browser download. The template endpoint returns
 * the bytes inline so the field guide can be rendered next to the button without
 * a second round trip.
 */
export function saveBase64File(fileName: string, contentBase64: string, contentType: string): void {
  const byteCharacters = atob(contentBase64);
  const bytes = new Uint8Array(byteCharacters.length);
  for (let index = 0; index < byteCharacters.length; index += 1) {
    bytes[index] = byteCharacters.charCodeAt(index);
  }
  triggerDownload(new Blob([bytes], { type: contentType }), fileName);
}

/**
 * Downloads a text payload already in hand, such as the CSV from the issues
 * export. Deliberately not routed through `btoa`: a raw cell value can contain
 * any character the uploader typed, and `btoa` throws outside Latin-1.
 */
export function saveTextFile(fileName: string, text: string, contentType: string): void {
  triggerDownload(new Blob([text], { type: contentType }), fileName);
}
