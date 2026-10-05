/**
 * Small JSON client for the game server (/api/v1). Same origin only. It never throws: every outcome is a plain
 * result so the callers (account, wallet, gifts) can stay playable when the server is down.
 */
export interface ApiResult<T = Record<string, unknown>> {
  /** HTTP status, 0 when the server could not be reached at all. */
  readonly status: number;
  readonly ok: boolean;
  /** Parsed JSON body, or null. */
  readonly body: T | null;
  /** The server could not be reached (offline, timeout, bad gateway): not an answer about the request. */
  readonly network: boolean;
  /** Machine code from the body (`error`, `reason` or `code`), or ''. */
  readonly code: string;
  /** Short text from the body, or ''. */
  readonly message: string;
}

export interface ApiOptions {
  /** Origin to talk to. Default: the page origin ('' = relative URLs). */
  readonly base?: string;
  readonly fetch?: typeof fetch;
  /** Bearer token to send, or null for anonymous calls. */
  readonly token?: () => string | null;
  readonly timeoutMs?: number;
}

export interface Api {
  get<T = Record<string, unknown>>(path: string): Promise<ApiResult<T>>;
  post<T = Record<string, unknown>>(path: string, body?: unknown): Promise<ApiResult<T>>;
  /** Same call with an explicit token (the recover flow before the token is stored). */
  withToken(token: string | null): Api;
}

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');

export function readFailure(body: unknown): { code: string; message: string } {
  if (!body || typeof body !== 'object') return { code: '', message: '' };
  const record = body as Record<string, unknown>;
  const nested = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : null;
  const code = text(nested?.code ?? (typeof record.error === 'string' ? record.error : undefined) ?? record.reason ?? record.code, 60);
  const message = text(nested?.message ?? record.message ?? (typeof record.error === 'string' && record.error.includes(' ') ? record.error : undefined), 200);
  return { code, message };
}

export function createApi(options: ApiOptions = {}): Api {
  const base = options.base ?? '';
  const timeoutMs = options.timeoutMs ?? 10_000;
  const make = (token: (() => string | null) | undefined): Api => {
    const call = async <T,>(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<ApiResult<T>> => {
      const doFetch = options.fetch ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
      if (!doFetch) return { status: 0, ok: false, body: null, network: true, code: 'offline', message: '' };
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const headers: Record<string, string> = { Accept: 'application/json' };
        const bearer = token?.();
        if (bearer) headers.Authorization = `Bearer ${bearer}`;
        if (method === 'POST') headers['Content-Type'] = 'application/json';
        const response = await doFetch(`${base}${path}`, {
          method, headers, cache: 'no-store', credentials: 'omit',
          ...(method === 'POST' ? { body: JSON.stringify(payload ?? {}) } : {}),
          ...(controller ? { signal: controller.signal } : {}),
        });
        let body: unknown = null;
        try { body = await response.json(); } catch { body = null; }
        const gateway = response.status === 502 || response.status === 503 || response.status === 504;
        const failure = response.ok ? { code: '', message: '' } : readFailure(body);
        return { status: response.status, ok: response.ok, body: (body && typeof body === 'object' ? body : null) as T | null, network: gateway, ...failure };
      } catch {
        return { status: 0, ok: false, body: null, network: true, code: 'offline', message: '' };
      } finally { if (timer) clearTimeout(timer); }
    };
    return {
      get: path => call('GET', path),
      post: (path, body) => call('POST', path, body),
      withToken: next => make(() => next),
    };
  };
  return make(options.token);
}
