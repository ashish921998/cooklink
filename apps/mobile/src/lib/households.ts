import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { useApi } from './api';
import { ApiError } from './api';

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
  defaultLanguage: 'en' | 'hi';
};

export type MealType = 'breakfast' | 'lunch' | 'dinner';

export type PlannedMeal = {
  id: string;
  date: string;
  mealType: MealType;
  name: string;
  servings: number;
  servingsOverridden: boolean;
  isSpecial: boolean;
  version: number;
  recipeId: string | null;
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

export type RecipeSearchResult = {
  recipeId: string;
  name: string;
  nameHi: string | null;
  dietStyle: string;
  dietMismatch: boolean;
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
 *
 * The probe re-runs whenever the app returns to the foreground so a removal
 * that happened while the app was backgrounded is caught on resume rather
 * than only when the Household id changes (issue 03 — recheck on refocus).
 *
 * While the app is in the foreground, the probe also re-runs on a 30-second
 * interval so a removal that happens during active use is caught within 30
 * seconds without waiting for a background→foreground transition (issue 03/04
 * — "removed participants immediately lose Chat access"). V1 has no
 * websocket/realtime push, so "immediately" means "on the next server
 * contact"; the 30-second probe is the lightest foreground contact that
 * still feels immediate. The interval is paused while the app is backgrounded
 * to avoid unnecessary battery drain.
 *
 * Only a definitive server denial (HTTP 403 or 404) flips `revoked` to true.
 * A network error or 5xx leaves the last known state intact so a transient
 * connectivity failure never kicks the user out of their own household
 * (issue 03 — do not treat connectivity failures as revoked access).
 */

/** The foreground re-probe cadence (issue 03/04 — "immediately exits"). */
const FOREGROUND_PROBE_INTERVAL_MS = 30_000;

export function useAccessProbe(householdId: string): {
  revoked: boolean;
  membershipId: string | null;
} {
  const api = useApi();
  const [revoked, setRevoked] = useState(false);
  const [membershipId, setMembershipId] = useState<string | null>(null);

  const probe = useCallback(async () => {
    // Do NOT clear membershipId here — the periodic 30-second probe would
    // flicker the Chat composer and mark-read logic to null on every tick.
    // membershipId is cleared only on Household change (the effect below).
    try {
      const res = await api<{ ok: boolean; membershipId?: string }>(
        `/v1/households/${householdId}/access`,
      );
      // A 200 means access is intact; the `ok` flag is always true on success
      // (a denial is a 403 thrown below), so reaching here clears any prior
      // revoked state, e.g. after the owner re-invites a removed person.
      setRevoked(false);
      if (res.membershipId) setMembershipId(res.membershipId);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        setRevoked(true);
      }
      // Any other failure (network error, 5xx) must NOT be treated as revoked:
      // keep the last known state so a connectivity blip does not exit the
      // user from protected content with a misleading "Access changed" screen.
    }
  }, [api, householdId]);

  // Probe on mount and whenever the open Household changes. Reset the prior
  // household's revoked flag and membershipId so its denial state never leaks
  // into the next one.
  useEffect(() => {
    setRevoked(false);
    setMembershipId(null);
    void probe();
  }, [probe]);

  // Re-probe when the app returns to the foreground so a removal that happened
  // while it was backgrounded is caught immediately on resume (issue 03). While
  // the app stays in the foreground, a 30-second interval catches removals
  // during active use without waiting for a background→foreground transition
  // (issue 03/04 — "immediately exits"). The interval is paused while
  // backgrounded to avoid unnecessary battery drain.
  useEffect(() => {
    let handle: ReturnType<typeof setInterval> | null = null;
    // Start the interval immediately if the app is already in the foreground
    // when the hook mounts — the 'change' event only fires on transitions, so
    // without this check the periodic probe would never begin during the
    // initial foreground session (the common case).
    if (AppState.currentState === 'active') {
      handle = setInterval(() => void probe(), FOREGROUND_PROBE_INTERVAL_MS);
    }
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void probe();
        if (!handle) {
          handle = setInterval(() => void probe(), FOREGROUND_PROBE_INTERVAL_MS);
        }
      } else if (handle) {
        clearInterval(handle);
        handle = null;
      }
    });
    return () => {
      subscription.remove();
      if (handle) clearInterval(handle);
    };
  }, [probe]);

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
    setError(null);
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
