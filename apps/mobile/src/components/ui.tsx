import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

/**
 * Shared Cooklink surface primitives. The palette and rhythm match the
 * existing onboarding screen so the whole app reads as one product.
 *
 * Touch targets meet the 44-pt iOS / 48-dp Android floor (issue 03 —
 * accessibility contract): every Pressable here uses at least 44pt of height
 * via padding.
 */

export const colors = {
  surface: '#f7f3ed',
  card: '#ffffff',
  ink: '#24352f',
  inkSoft: '#52625d',
  accent: '#136f63',
  accentSoft: '#c9ded7',
  field: '#e5e9e4',
  border: '#dfe5df',
  danger: '#a33a2a',
  brand: '#6f4f2d',
};

export const styles = StyleSheet.create({
  screen: { flexGrow: 1, padding: 24, paddingTop: 56, backgroundColor: colors.surface, gap: 16 },
  centerScreen: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
    backgroundColor: colors.surface,
    gap: 16,
  },
  eyebrow: { fontSize: 13, fontWeight: '700', color: colors.brand, textTransform: 'uppercase' },
  title: { fontSize: 34, fontWeight: '700', color: colors.ink },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: colors.ink, marginTop: 8 },
  subtitle: { fontSize: 16, lineHeight: 22, color: colors.inkSoft },
  input: {
    borderWidth: 1,
    borderColor: '#c8d0c8',
    borderRadius: 8,
    padding: 14,
    fontSize: 18,
    backgroundColor: colors.card,
  },
  primaryButton: { borderRadius: 8, padding: 16, backgroundColor: colors.accent, alignItems: 'center' },
  primaryButtonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  secondaryButton: {
    borderRadius: 8,
    padding: 14,
    backgroundColor: colors.ink,
    alignItems: 'center',
  },
  secondaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  ghostButton: {
    borderRadius: 8,
    padding: 14,
    backgroundColor: colors.field,
    alignItems: 'center',
  },
  ghostButtonText: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  backLink: { color: colors.accent, fontSize: 17, fontWeight: '700' },
  disabled: { opacity: 0.7 },
  segment: { flexDirection: 'row', gap: 8 },
  segmentButton: {
    flex: 1,
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
    backgroundColor: colors.field,
  },
  segmentActive: { backgroundColor: colors.accentSoft },
  segmentText: { color: colors.ink, fontWeight: '700' },
  error: { color: colors.danger },
  card: {
    borderRadius: 8,
    backgroundColor: colors.card,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 10,
  },
  selectedCard: { borderColor: colors.accent, backgroundColor: '#eff7f4' },
  cardTitle: { fontSize: 20, fontWeight: '700', color: colors.ink },
  listItem: { fontSize: 16, color: colors.inkSoft, paddingVertical: 4 },
  mealRow: { flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 4 },
  dayGroup: { gap: 8, paddingVertical: 6 },
  mealType: {
    width: 86,
    fontSize: 13,
    color: colors.brand,
    textTransform: 'uppercase',
    fontWeight: '700',
  },
  mealName: { flex: 1, fontSize: 17, color: colors.ink },
});

export function Loading() {
  return (
    <View style={styles.centerScreen}>
      <ActivityIndicator />
    </View>
  );
}

export function Message({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.centerScreen}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{body}</Text>
    </View>
  );
}

/**
 * The persistent three-destination bottom bar (issue 03 — Variant A). Each tab
 * is icon-plus-text and meets the touch-target floor. The bar shows exactly
 * three labelled choices; Household Chat is never a fourth tab.
 */
export type TabKey = 'today' | 'mealPlan' | 'groceries' | 'chat';

export interface TabSpec {
  key: TabKey;
  label: string;
  glyph: string;
}

export function BottomTabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: readonly TabSpec[];
  active: TabKey;
  onSelect: (key: TabKey) => void;
}) {
  return (
    <View style={tabStyles.bar}>
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="button"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={tab.label}
            style={[tabStyles.tab, isActive && tabStyles.tabActive]}
            onPress={() => onSelect(tab.key)}
          >
            <Text style={[tabStyles.glyph, isActive && tabStyles.glyphActive]}>{tab.glyph}</Text>
            <Text style={[tabStyles.label, isActive && tabStyles.labelActive]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const tabStyles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingBottom: 4,
  },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', gap: 2, minHeight: 56 },
  tabActive: {},
  glyph: { fontSize: 20, color: colors.inkSoft },
  glyphActive: { color: colors.accent },
  label: { fontSize: 12, fontWeight: '700', color: colors.inkSoft },
  labelActive: { color: colors.accent },
});

/** A header action that opens Household Chat (issue 03 — Chat is not a tab). */
export function ChatHeaderAction({
  unread,
  onPress,
}: {
  unread?: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Household Chat${unread ? `, ${unread} unread` : ''}`}
      style={chatStyles.button}
      onPress={onPress}
    >
      <Text style={chatStyles.glyph}>💬</Text>
      <Text style={chatStyles.label}>Chat</Text>
      {unread ? (
        <View style={chatStyles.badge}>
          <Text style={chatStyles.badgeText}>{unread > 9 ? '9+' : unread}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const chatStyles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    minHeight: 44,
    borderRadius: 8,
    backgroundColor: colors.field,
  },
  glyph: { fontSize: 16 },
  label: { fontSize: 14, fontWeight: '700', color: colors.ink },
  badge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
});

export function Card({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={[styles.card, style]}>{children}</View>;
}
