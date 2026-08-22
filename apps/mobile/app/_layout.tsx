import { ClerkProvider, useAuth } from '@clerk/expo';
import {
  DMSans_400Regular,
  DMSans_400Regular_Italic,
  DMSans_500Medium,
  DMSans_600SemiBold,
  DMSans_700Bold,
} from '@expo-google-fonts/dm-sans';
import { DMSerifDisplay_400Regular } from '@expo-google-fonts/dm-serif-display';
import { tokenCache } from '@clerk/expo/token-cache';
import { useFonts } from 'expo-font';
import { Slot } from 'expo-router';
import { useCallback, useRef, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ApiTokenResolverContext } from '../src/lib/api';
import { DesignPreviewApiProvider } from '../src/lib/design-preview';
import { fonts } from '../src/theme/typography';

const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
const designPreviewEnabled = __DEV__ && process.env.EXPO_PUBLIC_COOKLINK_DESIGN_PREVIEW === 'true';

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    [fonts.body]: DMSans_400Regular,
    [fonts.bodyItalic]: DMSans_400Regular_Italic,
    [fonts.medium]: DMSans_500Medium,
    [fonts.semibold]: DMSans_600SemiBold,
    [fonts.bold]: DMSans_700Bold,
    [fonts.display]: DMSerifDisplay_400Regular,
  });

  if (fontError) throw fontError;
  if (!fontsLoaded) return null;

  if (designPreviewEnabled) {
    return (
      <AppFrame>
        <DesignPreviewApiProvider>
          <StatusBar style="dark" />
          <Slot />
        </DesignPreviewApiProvider>
      </AppFrame>
    );
  }
  if (!publishableKey) {
    throw new Error('EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is required.');
  }

  // GestureHandlerRootView is required for the tab bar's scrub gesture (expo-router
  // does not add it); SafeAreaProvider feeds the floating bar its bottom inset.
  return (
    <AppFrame>
      <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
        <AuthenticatedApiBridge>
          <StatusBar style="dark" />
          <Slot />
        </AuthenticatedApiBridge>
      </ClerkProvider>
    </AppFrame>
  );
}

function AppFrame({ children }: { children: ReactNode }) {
  return (
    <GestureHandlerRootView style={styles.appFrame}>
      <SafeAreaProvider>{children}</SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function AuthenticatedApiBridge({ children }: { children: ReactNode }) {
  const { getToken } = useAuth();
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const resolveToken = useCallback(() => getTokenRef.current(), []);
  return (
    <ApiTokenResolverContext.Provider value={resolveToken}>
      {children}
    </ApiTokenResolverContext.Provider>
  );
}

const styles = StyleSheet.create({
  appFrame: {
    flex: 1,
  },
});
