import { Image, StyleSheet, View } from 'react-native';
import type { ImageStyle, ViewStyle } from 'react-native';
import brandMark from '../../assets/brand-mark.png';
import { colors } from './design-system';
import { Text } from './Typography';

type BrandLogoProps = {
  compact?: boolean;
};

export function BrandLogo({ compact = false }: BrandLogoProps) {
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel="Cooklink"
      style={compact ? compactLockupStyle : styles.lockup}
    >
      <Image
        source={brandMark}
        resizeMode="contain"
        style={compact ? compactMarkStyle : styles.mark}
      />
      {!compact ? <Text style={styles.wordmark}>cooklink</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // No alignSelf here, so the lockup inherits whatever alignment its parent
  // sets: left in a default column, centred on the sign-in screen.
  lockup: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  lockupCompact: {
    alignSelf: 'center',
  },
  mark: {
    height: 64,
    width: 64,
  },
  markCompact: {
    height: 44,
    width: 44,
  },
  wordmark: {
    color: colors.ink,
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: -1,
  },
});

const compactLockupStyle = StyleSheet.compose<ViewStyle, ViewStyle, ViewStyle>(
  styles.lockup,
  styles.lockupCompact,
);
const compactMarkStyle = StyleSheet.compose<ImageStyle, ImageStyle, ImageStyle>(
  styles.mark,
  styles.markCompact,
);
