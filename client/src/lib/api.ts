/** Error returned by the MedexRegAI API: { success:false, error:{ code, message, details } }. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: { field: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Message for one form field, from the API's validation details. */
  fieldError(field: string): string | undefined {
    return this.details?.find((d) => d.field === field)?.message;
  }
}

export interface ApiRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  token?: string;
}

/** Call the API (same origin; Vite proxies /api to the server in development). */
export async function apiRequest<T>(path: string, { method = 'GET', body, token }: ApiRequest = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  let response: Response;
  try {
    response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach MedexRegAI. Check your connection and try again.');
  }
  // 204 No Content (e.g. DELETE) has no body to parse.
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => null)) as
    { success: true; data: T } | { success: false; error: { code: string; message: string; details?: { field: string; message: string }[] } } | null;
  if (!response.ok || !payload || payload.success === false) {
    const error = payload && payload.success === false ? payload.error : undefined;
    throw new ApiError(response.status, error?.code ?? 'INTERNAL_ERROR', error?.message ?? 'Something went wrong. Please try again.', error?.details);
  }
  return payload.data;
}
