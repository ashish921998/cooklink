import { createContext, useCallback, useContext } from 'react';

const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
export const devAuthEnabled = __DEV__ && process.env.EXPO_PUBLIC_COOKLINK_DEV_AUTH === 'true';

export const devAuthHeaders: Record<string, string> = devAuthEnabled
  ? {
      'x-clerk-user-id':
        process.env.EXPO_PUBLIC_COOKLINK_DEV_USER_ID ?? 'cooklink-mobile-dev-owner',
      'x-cooklink-dev-phone': process.env.EXPO_PUBLIC_COOKLINK_DEV_PHONE ?? '+919999000001',
      'x-cooklink-dev-name': process.env.EXPO_PUBLIC_COOKLINK_DEV_NAME ?? 'Mobile Dev Owner',
    }
  : {};

export type ApiRequest = <T>(path: string, init?: RequestInit) => Promise<T>;
export type TokenResolver = (() => Promise<string | null>) | null;

/** Runtime injection points: Clerk supplies a token resolver; design preview supplies a local API. */
export const ApiTokenResolverContext = createContext<TokenResolver>(null);
export const ApiRequestOverrideContext = createContext<ApiRequest | null>(null);

const resolveWithoutToken = async () => null;

/** A stable token capability for API and authorized-media consumers. */
export function useTokenResolver(): Exclude<TokenResolver, null> {
  const runtimeTokenResolver = useContext(ApiTokenResolverContext);
  return devAuthEnabled ? resolveWithoutToken : (runtimeTokenResolver ?? resolveWithoutToken);
}

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
  const tokenResolver = useTokenResolver();
  const requestOverride = useContext(ApiRequestOverrideContext);

  return useCallback(
    async function request<T>(path: string, init?: RequestInit): Promise<T> {
      if (requestOverride) return requestOverride<T>(path, init);
      const token = await tokenResolver();
      const res = await fetch(`${apiUrl}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...devAuthHeaders,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...init?.headers,
        },
      });
      if (!res.ok) {
        throw new ApiError(res.status, await res.text());
      }
      return (await res.json()) as T;
    },
    [requestOverride, tokenResolver],
  );
}
