import { Redirect, useRouter, useLocalSearchParams } from 'expo-router';
import { useUser } from '@clerk/expo';
import { useCallback } from 'react';
import { AcceptInvite } from '../src/screens/AcceptInvite';
import { devAuthEnabled } from '../src/lib/api';
import { Loading } from '../src/components/design-system';

/**
 * The deep-link entry for invite acceptance (issue 03). A WhatsApp message
 * carries a `cooklink://invite?token=...` link; tapping it opens this route
 * with the token pre-filled so the recipient can accept in one tap.
 *
 * The route also serves the manual "I have an invite" path from the
 * no-households screen, in which case `token` is empty and the person pastes
 * it themselves.
 *
 * A not-yet-signed-in visitor is redirected to the home route's phone-OTP
 * flow, but the invite token is preserved as a `pending_invite_token` query
 * parameter so that after OTP verification the home route redirects back
 * here with the token still in hand. The recipient never has to re-tap the
 * WhatsApp link (the invite is single-use and seven-day, so this is safe).
 */
export default function InviteRoute() {
  const { isLoaded, isSignedIn } = useUser();
  const router = useRouter();
  const params = useLocalSearchParams<{
    token?: string | string[];
    expected_role?: string | string[];
  }>();
  const returnHome = useCallback(() => router.replace('/'), [router]);

  if (!devAuthEnabled && !isLoaded) return <Loading />;

  const raw = params.token;
  const prefillToken = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  const rawExpectedRole = params.expected_role;
  const expectedRoleValue = Array.isArray(rawExpectedRole) ? rawExpectedRole[0] : rawExpectedRole;
  const expectedRole =
    expectedRoleValue === 'member' || expectedRoleValue === 'cook' ? expectedRoleValue : undefined;

  // Redirect declaratively: navigating from the render body re-enters the
  // navigator on every render, which trips React's update-depth limit.
  if (!devAuthEnabled && !isSignedIn) {
    return (
      <Redirect
        href={prefillToken ? `/?pending_invite_token=${encodeURIComponent(prefillToken)}` : '/'}
      />
    );
  }

  return (
    <AcceptInvite
      prefillToken={prefillToken}
      expectedRole={expectedRole}
      onAccepted={returnHome}
      onCancel={returnHome}
    />
  );
}
