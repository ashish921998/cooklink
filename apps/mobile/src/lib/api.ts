import { useCallback } from 'react';
import { useAuth } from '@clerk/clerk-expo';

const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

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
        throw new Error(`API ${res.status}: ${await res.text()}`);
      }
      return (await res.json()) as T;
    },
    [getToken],
  );
}
