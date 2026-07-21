import { createTheme, rem, type MantineColorsTuple } from '@mantine/core';

// "Sandstone teal · mist" brand palette.
// Anchors: primary #4FA3A0 (shade 6), hover #3F8683 (shade 7),
// ink #2A3335 / ink-deep #1E2627 (dark surfaces), mist #A2B3B1,
// accent-text #586E6B, muted #96A6A5, border #C8D2D1, paper #F7F5F0.
const sandstone: MantineColorsTuple = [
  '#eef6f5', // 0
  '#d9eae9', // 1
  '#bfdbd9', // 2
  '#a2b3b1', // 3  mist — fills, badges, outlines
  '#86bab7', // 4
  '#68aeaa', // 5
  '#4fa3a0', // 6  primary
  '#3f8683', // 7  primary hover
  '#586e6b', // 8  accent text on light backgrounds
  '#2f5250', // 9
];

// Ink-tinted dark scheme surfaces (Mantine dark scale):
// dark-7 = body (#2A3335 ink), dark-6 = cards, dark-8/9 toward ink-deep,
// dark-2 = dimmed text (#96A6A5 muted).
const dark: MantineColorsTuple = [
  '#cdd6d5', // 0  primary text
  '#aebcba', // 1
  '#96a6a5', // 2  muted / dimmed text
  '#7b8c8b', // 3
  '#4e5d5f', // 4  borders
  '#3e4b4e', // 5
  '#2c3639', // 6  card surfaces
  '#232b2d', // 7  body — ink
  '#1c2223', // 8
  '#161b1c', // 9  ink deep — terminals, code blocks
];

// Mist/accent-text gray-teal — understated "meta" marker (workflow chrome).
// Anchored on accent-text #586E6B (shade 6) and mist #A2B3B1 (shade 3).
const slate: MantineColorsTuple = [
  '#eef1f1', // 0
  '#dde3e3', // 1
  '#c8d2d1', // 2  border
  '#a2b3b1', // 3  mist
  '#8a9c9a', // 4
  '#738785', // 5
  '#586e6b', // 6  accent text
  '#4a5c5a', // 7
  '#3c4b49', // 8
  '#2f3c3a', // 9
];

export const theme = createTheme({
  colors: { sandstone, dark, slate },
  primaryColor: 'sandstone',
  primaryShade: 6,
  autoContrast: true,
  defaultRadius: 'md',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  fontFamilyMonospace:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  fontSizes: {
    xs: rem(11),
    sm: rem(12.5),
    md: rem(14),
    lg: rem(16),
    xl: rem(18),
  },
  headings: { fontWeight: '600' },
  components: {
    Button: { defaultProps: { size: 'xs' } },
    Select: { defaultProps: { size: 'xs', checkIconPosition: 'right' } },
    TextInput: { defaultProps: { size: 'xs' } },
    Textarea: { defaultProps: { size: 'xs' } },
    Badge: { defaultProps: { size: 'xs' } },
  },
});
