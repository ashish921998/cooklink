import { useCallback, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { useApi } from './api';

/**
 * The role a person holds within one Household. The server is the only source
 * of truth for role; the client uses it solely to choose the entry shell
 * (issue 03 — role-aware navigation). A person has one role per Household and
 * may be a Member at home and a Cook elsewhere.
 */
export type HouseholdRole = 'owner' | 'member' | 'cook';

export type HouseholdSummary = {
  id: string;
  name: string;
  role: HouseholdRole;
  servingCount: number;
  mealStyle: string;
  dietStyle: string;
};

export type MealType = 'breakfast' | 'lunch' | 'dinner';

export type PlannedMeal = {
  id: string;
  date: string;
  mealType: MealType;
  name: string;
  servings: number;
  isSpecial: boolean;
};

export type HouseholdMember = {
  id: string;
  role: HouseholdRole;
  status: string;
  notificationDefault: string;
};

export type InviteSummary = {
  id: string;
  role: 'member' | 'cook';
  phoneMasked: string;
  expiresAt: string;
};

/** The two areas a person with both kinds of membership moves between. */
export type HouseholdArea = 'home' | 'work';

/**
 * Re-authorize against a Household on entry so a removed or revoked person
 * exits protected content immediately with a plain explanation (issue 03).
 * Returns `true` once the server confirms access is gone. Household-scoped
 * data is never rendered while the probe is in flight or after a denial.
 *
 * The probe also returns the caller's `membershipId`, which the chat client
 * uses to attribute its own messages (issue 04).
 */
export function useAccessProbe(householdId: string): {
  revoked: boolean;
  membershipId: string | null;
} {
  const api = useApi();
  const [revoked, setRevoked] = useState(false);
  const [membershipId, setMembershipId] = useState<string | null>(null);

  useEffect(() => {
    setRevoked(false);
    setMembershipId(null);
    let cancelled = false;
    api<{ ok: boolean; membershipId?: string }>(`/v1/households/${householdId}/access`)
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setRevoked(true);
        } else if (res.membershipId) {
          setMembershipId(res.membershipId);
        }
      })
      .catch(() => {
        if (!cancelled) setRevoked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, householdId]);

  return { revoked, membershipId };
}

const LAST_AREA_KEY = 'cooklink.lastArea';
const LAST_HOME_KEY = 'cooklink.lastHome';
const LAST_WORK_KEY = 'cooklink.lastWork';

/** Read a remembered id; never throws if storage is unavailable. */
async function readRemembered(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function writeRemembered(key: string, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value);
  } catch {
    // Remembered state is a convenience, not a source of truth; ignore failures.
  }
}

/**
 * Load the authenticated person's memberships and resolve which Household and
 * area they should land on, while remembering their last choice per area
 * (issue 03 — the app remembers the last area).
 *
 * The selection rules follow Variant A:
 * - A Cook always lands on the Work household list, even with one Household.
 * - A Member (or Owner) lands on the active Household's Today.
 * - Someone with both kinds of membership keeps the last area they used and
 *   can switch between My home and Work households.
 */
export function useHouseholds() {
  const api = useApi();
  const [households, setHouseholds] = useState<HouseholdSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [area, setArea] = useState<HouseholdArea>('home');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const loadHouseholds = useCallback(async () => {
    const data = await api<{ households: HouseholdSummary[] }>('/v1/households');
    setHouseholds(data.households);
    return data.households;
  }, [api]);

  // On first load, resolve the remembered area and the matching Household.
  useEffect(() => {
    loadHouseholds().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : 'Could not load households.'),
    );
  }, [loadHouseholds]);

  // Restore the remembered area and selected household once we know the set.
  useEffect(() => {
    if (!households || households.length === 0) return;
    const hasCook = households.some((h) => h.role === 'cook');
    const hasMember = households.some((h) => h.role !== 'cook');
    void (async () => {
      if (hasCook && hasMember) {
        const rememberedArea = await readRemembered(LAST_AREA_KEY);
        const next: HouseholdArea = rememberedArea === 'work' ? 'work' : 'home';
        setArea(next);
      } else {
        setArea(hasCook ? 'work' : 'home');
      }
    })();
  }, [households]);

  // Whenever the area changes, restore the remembered household for that area,
  // defaulting to the first Household in the area.
  useEffect(() => {
    if (!households || households.length === 0) return;
    const inArea = households.filter((h) =>
      area === 'work' ? h.role === 'cook' : h.role !== 'cook',
    );
    void (async () => {
      const key = area === 'work' ? LAST_WORK_KEY : LAST_HOME_KEY;
      const remembered = await readRemembered(key);
      const match = inArea.find((h) => h.id === remembered);
      setSelectedId(match ? match.id : (inArea[0]?.id ?? null));
    })();
  }, [area, households]);

  const chooseArea = useCallback((next: HouseholdArea) => {
    setArea(next);
    void writeRemembered(LAST_AREA_KEY, next);
  }, []);

  const chooseHousehold = useCallback(
    (householdId: string) => {
      setSelectedId(householdId);
      const key = area === 'work' ? LAST_WORK_KEY : LAST_HOME_KEY;
      void writeRemembered(key, householdId);
    },
    [area],
  );

  const homeHouseholds = households?.filter((h) => h.role !== 'cook') ?? [];
  const workHouseholds = households?.filter((h) => h.role === 'cook') ?? [];
  const inArea = area === 'work' ? workHouseholds : homeHouseholds;
  const selected = inArea.find((h) => h.id === selectedId) ?? inArea[0] ?? null;

  return {
    households,
    error,
    setError,
    loadHouseholds,
    area,
    chooseArea,
    homeHouseholds,
    workHouseholds,
    selected,
    chooseHousehold,
  };
}
