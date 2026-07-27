import { useCallback } from 'react';
import { useAuth } from '@clerk/clerk-expo';

const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

/**
 * A failed API request. Carries the HTTP status so callers can distinguish a
 * definitive server verdict (403/404 = access revoked) from a connectivity
 * failure (no status) and react accordingly (issue 03 — do not kick the user
 * out on a network blip).
 *
 * Extends `Error` so existing `err instanceof Error` handlers and the
 * `message` surface keep working unchanged.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`API ${status}: ${body}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export function useApi() {
  const { getToken } = useAuth();

  return useCallback(
    async function request<T>(path: string, init?: RequestInit): Promise<T> {
      const token = await getToken();
      const res = await fetch(`${apiUrl}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...init?.headers,
        },
      });
      if (!res.ok) {
        throw new ApiError(res.status, await res.text());
      }
      return (await res.json()) as T;
    },
    [getToken],
  );
}
