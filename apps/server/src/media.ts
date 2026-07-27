import { randomUUID } from 'node:crypto';

/**
 * Private media storage for Household Chat photos and voice notes (ticket 06).
 *
 * The stored `mediaRef` is an OPAQUE key, never a public permanent URL. The
 * only way to read media back is through the authorized server endpoint, which
 * re-checks the `(user, household, role)` membership on every request and
 * proxies the bytes from this store (issue 06, AC#3 — private media is
 * accessible only through short-lived authorized access and never through a
 * public permanent URL).
 *
 * V1 ships an in-memory store (tests + local dev) and a local-file store
 * (dev). The production R2 implementation conforms to the same interface; its
 * key is held in server env only and never reaches the mobile bundle.
 */

export type MediaKind = 'photo' | 'voice';

export interface StoredMedia {
  mediaRef: string;
  householdId: string;
  kind: MediaKind;
  contentType: string;
  bytes: number;
}

export interface ResolvedMedia {
  data: Buffer;
  contentType: string;
  kind: MediaKind;
}

export interface MediaStore {
  /** Store a private media object and return an opaque reference. */
  put(input: {
    householdId: string;
    kind: MediaKind;
    contentType: string;
    data: Buffer;
  }): Promise<StoredMedia>;
  /**
   * Resolve a media reference for a given household. Returns null when the
   * reference does not exist or does not belong to that household, so a
   * cross-household mediaRef can never yield bytes (issue 06, AC#8).
   */
  resolve(mediaRef: string, householdId: string): Promise<ResolvedMedia | null>;
  /** Schedule deletion of a media object (issue 06 — delete revokes access). */
  delete(mediaRef: string): Promise<void>;
  /**
   * Optional TTL sweep hook (issue 07, AC#17/AC#18). A production R2 store
   * purges orphaned/expired objects (e.g. TTS audio at 90 days); the in-memory
   * store leaves this unimplemented so the scheduler job is a no-op.
   */
  sweepTtl?(now: Date): Promise<{ affected: number }>;
}

/**
 * A fully in-memory {@link MediaStore} used by the test suite and local dev.
 * Media is keyed by an opaque token and tagged with the owning household so a
 * cross-household resolve can never succeed.
 */
export class InMemoryMediaStore implements MediaStore {
  private readonly objects = new Map<
    string,
    { householdId: string; kind: MediaKind; contentType: string; data: Buffer }
  >();

  async put(input: {
    householdId: string;
    kind: MediaKind;
    contentType: string;
    data: Buffer;
  }): Promise<StoredMedia> {
    const mediaRef = `media/${randomUUID()}`;
    this.objects.set(mediaRef, {
      householdId: input.householdId,
      kind: input.kind,
      contentType: input.contentType,
      data: input.data,
    });
    return {
      mediaRef,
      householdId: input.householdId,
      kind: input.kind,
      contentType: input.contentType,
      bytes: input.data.byteLength,
    };
  }

  async resolve(mediaRef: string, householdId: string): Promise<ResolvedMedia | null> {
    const obj = this.objects.get(mediaRef);
    if (!obj || obj.householdId !== householdId) return null;
    return { data: obj.data, contentType: obj.contentType, kind: obj.kind };
  }

  async delete(mediaRef: string): Promise<void> {
    this.objects.delete(mediaRef);
  }
}

/**
 * Resolve a media store for the server. V1 ships the in-memory store, which is
 * used by tests and local dev. A production R2 implementation conforms to the
 * same {@link MediaStore} interface and is selected by wiring a custom store
 * into `createApp`; its key is held in server env only and never reaches the
 * mobile bundle (issue 07 — no provider secret in the mobile bundle).
 */
export function createMediaStore(): MediaStore {
  return new InMemoryMediaStore();
}
