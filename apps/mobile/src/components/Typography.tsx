import type { ComponentProps } from 'react';
import {
  StyleSheet,
  Text as NativeText,
  TextInput as NativeTextInput,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import { bodyFontForWeight, fonts } from '../theme/typography';

function exactFontStyle(style: StyleProp<TextStyle>): TextStyle {
  const resolved = StyleSheet.flatten(style);

  if (resolved?.fontFamily === fonts.display) {
    return { fontFamily: fonts.display, fontWeight: '400' };
  }

  if (resolved?.fontStyle === 'italic') {
    return { fontFamily: fonts.bodyItalic, fontStyle: 'normal', fontWeight: '400' };
  }

  return {
    fontFamily: bodyFontForWeight(resolved?.fontWeight),
    fontWeight: '400',
  };
}

export function Text({ style, ...props }: ComponentProps<typeof NativeText>) {
  return <NativeText {...props} style={StyleSheet.compose(style, exactFontStyle(style))} />;
}

export function TextInput({ style, ...props }: ComponentProps<typeof NativeTextInput>) {
  return <NativeTextInput {...props} style={StyleSheet.compose(style, exactFontStyle(style))} />;
}
