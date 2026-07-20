import { createTheme, rem } from '@mantine/core';

export const theme = createTheme({
  primaryColor: 'orange',
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
