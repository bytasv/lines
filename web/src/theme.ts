import { createTheme, rem, virtualColor, type MantineColorsTuple } from '@mantine/core';

// Monochrome palette: black, white and neutral grays. There is no accent hue —
// "active" is carried by contrast and shape, and colour is reserved for status
// and attention (blue running, green done, yellow needs you, red error).
//
// Primary is `mono`, a virtual colour: near-black in the light scheme and a soft
// light gray in the dark one, so filled controls invert with the scheme. It has
// to be virtual rather than one tuple under a per-scheme `primaryShade`, for two
// reasons: `primaryShade` also picks the filled/outline shade of every status
// colour (red, blue, green…), and Mantine's filled variants choose black or
// white text from the light-scheme shade alone — a virtual colour gets a
// per-scheme `--mantine-color-mono-contrast` instead.
//
// Both tuples are laid out by role at `primaryShade: 6`, not as smooth ramps:
//   light scheme: 6 filled / outline / text, 7 filled hover,
//                 1 light bg, 2 light hover, 9 light text
//   dark scheme:  6 filled, 7 filled hover, 2 outline, 4 text / anchor,
//                 0 light text, 9 base of the light bg (darkened 50% / 30%)
const monoLight: MantineColorsTuple = [
  '#fafafa', // 0
  '#f0f0f0', // 1  light variant background
  '#e5e5e5', // 2  light variant hover
  '#d4d4d4', // 3
  '#a3a3a3', // 4
  '#737373', // 5
  '#171717', // 6  primary — filled, outline, text
  '#333333', // 7  filled hover
  '#262626', // 8
  '#0a0a0a', // 9  light variant text
];

const monoDark: MantineColorsTuple = [
  '#e5e5e5', // 0  light / subtle variant text
  '#d4d4d4', // 1
  '#bdbdbd', // 2  outline
  '#a3a3a3', // 3
  '#e0e0e0', // 4  text, anchors
  '#bababa', // 5
  '#d4d4d4', // 6  primary — filled
  '#bababa', // 7  filled hover
  '#8a8a8a', // 8
  '#666666', // 9  light variant background base (→ #333 / #474747)
];

// Neutral dark scheme surfaces (Mantine dark scale). Deliberately a charcoal
// gray rather than near-black, with off-white text, so dark mode stays low
// glare: dark-7 = body, dark-6 = cards, dark-4 = borders, dark-2 = dimmed text,
// dark-9 = deep surfaces (terminals, code blocks).
const dark: MantineColorsTuple = [
  '#d4d4d4', // 0  primary text
  '#bababa', // 1
  '#999999', // 2  muted / dimmed text
  '#767676', // 3
  '#3a3a3a', // 4  borders
  '#2f2f2f', // 5
  '#262626', // 6  card surfaces
  '#1e1e1e', // 7  body
  '#191919', // 8
  '#141414', // 9  deep — terminals, code blocks
];

// Status hues, muted. Mantine's hue angles re-ramped in OKLCH on one shared
// lightness curve (shade 6, the dot / filled shade, ≈ L 0.60) at roughly two
// thirds of Mantine's chroma, so no status shouts louder than another. Yellow and
// orange keep more chroma (desaturated, they turn brown) and yellow sits lighter
// so filled yellow keeps black text. Teal and cyan sit at 180° / 218°, not
// Mantine's 165° / 210°: muted, those let done, needs answer and needs approval
// blur together. Retune the set together, not one hue.
const hues: Record<string, MantineColorsTuple> = {
  red: ['#fff4f3', '#ffe9e6', '#ffd4d0', '#fbb7b1', '#ec9790', '#d77a74', '#bf5f5a', '#a8504c', '#90423f', '#763734'],
  pink: ['#fff3f6', '#ffe8ed', '#fcd4dc', '#f3b8c6', '#e299ab', '#cd7d92', '#b5637a', '#9f5469', '#884658', '#703a49'],
  grape: ['#fcf4fe', '#f7e9fb', '#edd7f4', '#dfbde8', '#ca9fd6', '#b384c0', '#9c6aa9', '#885a94', '#744c7e', '#5f3e68'],
  violet: ['#f6f6ff', '#edecff', '#dedbfd', '#c8c4f6', '#aea8e7', '#968ed4', '#7e75bd', '#6d64a6', '#5c548e', '#4c4575'],
  indigo: ['#f3f7ff', '#e8eeff', '#d3dfff', '#b7caf9', '#99afeb', '#7e96d8', '#657dc1', '#566baa', '#485b92', '#3b4b78'],
  blue: ['#f1f8ff', '#e3f0ff', '#c9e3fe', '#a9cff7', '#85b6e9', '#669dd5', '#4b84be', '#3d72a8', '#31608f', '#295076'],
  cyan: ['#ecfafe', '#dbf4fb', '#bfe8f4', '#96d6e9', '#69bfd7', '#3ea7c2', '#278ea7', '#207b90', '#1a687b', '#145666'],
  teal: ['#ecfbf7', '#dbf5ef', '#c0eae1', '#98dacc', '#6bc4b3', '#40ad9b', '#279382', '#217f71', '#1a6c5f', '#14594e'],
  green: ['#f0faf1', '#e3f4e4', '#cde8ce', '#aed7b0', '#8bc18f', '#6da972', '#529158', '#437e4a', '#376b3d', '#2e5833'],
  lime: ['#f3f9ee', '#e8f3df', '#d5e6c7', '#bbd5a5', '#9dbd81', '#82a561', '#698d46', '#597b38', '#4b682d', '#3e5626'],
  yellow: ['#fff7ec', '#feeed6', '#f9dfb7', '#f2ca8c', '#e7b461', '#d89f3a', '#ce9218', '#b88004', '#9d6d00', '#835b08'],
  orange: ['#fff4ee', '#ffeade', '#ffd6bf', '#f8bb98', '#eca072', '#db8652', '#c66f35', '#b05f28', '#975120', '#7e441d'],
};

// Mantine's gray without its blue tint, so gray controls and light-scheme dimmed
// text match the neutral scales above.
const gray: MantineColorsTuple = [
  '#f9f9f9',
  '#f3f3f3',
  '#ececec',
  '#e1e1e1',
  '#d3d3d3',
  '#b4b4b4',
  '#737373', // 6  light-scheme dimmed text — darker than Mantine's, for 4.7:1 on white
  '#4f4f4f',
  '#393939',
  '#242424',
];

export const theme = createTheme({
  colors: {
    monoLight,
    monoDark,
    mono: virtualColor({ name: 'mono', light: 'monoLight', dark: 'monoDark' }),
    dark,
    gray,
    ...hues,
  },
  primaryColor: 'mono',
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
    Switch: { defaultProps: { size: 'xs' } },
    // Their auto-contrast check mark cannot read a virtual colour and falls back
    // to white — invisible on the light-gray dark-scheme fill. Every checkbox and
    // radio here uses the primary colour, so its contrast variable is right.
    Checkbox: { defaultProps: { iconColor: 'var(--mantine-primary-color-contrast)' } },
    Radio: { defaultProps: { iconColor: 'var(--mantine-primary-color-contrast)' } },
  },
});
