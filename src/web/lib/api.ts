export class ApiError extends Error {
  readonly status: number;
  readonly details: { fields?: Record<string, string>; [k: string]: unknown } | null;
  constructor(message: string, status: number, details: ApiError['details']) {
    super(message);
    this.status = status;
    this.details = details;
  }
  field(name: string): string | undefined {
    return this.details?.fields?.[name];
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'yfx',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Cannot reach the YuvrajFX server. Is it still running?', 0, null);
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data as { error?: { message?: string } } | null)?.error?.message ?? `Request failed (${res.status}).`;
    const details = (data as { error?: { details?: ApiError['details'] } } | null)?.error?.details ?? null;
    if (res.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new CustomEvent('yfx:unauthorized'));
    if (res.status === 403 && (details as { code?: string } | null)?.code === 'PASSWORD_CHANGE_REQUIRED') window.dispatchEvent(new CustomEvent('yfx:unauthorized'));
    throw new ApiError(message, res.status, details);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
};

/** Build a query string, skipping empty values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    sp.set(k, v === true ? '1' : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}
