import type { TextStyle } from 'react-native';

/** Exact type families used by the validated Cooklink visual template. */
export const fonts = {
  body: 'DMSans_400Regular',
  bodyItalic: 'DMSans_400Regular_Italic',
  medium: 'DMSans_500Medium',
  semibold: 'DMSans_600SemiBold',
  bold: 'DMSans_700Bold',
  display: 'DMSerifDisplay_400Regular',
} as const;

export function bodyFontForWeight(weight: TextStyle['fontWeight']) {
  if (weight === 'bold') return fonts.bold;
  const numericWeight = typeof weight === 'number' ? weight : Number.parseInt(weight ?? '400', 10);
  if (numericWeight >= 700) return fonts.bold;
  if (numericWeight >= 600) return fonts.semibold;
  if (numericWeight >= 500) return fonts.medium;
  return fonts.body;
}
