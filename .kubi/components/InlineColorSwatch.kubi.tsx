import { InlineColorSwatch } from '../../web/src/components/InlineColorSwatch';

export default {
  component: InlineColorSwatch,
  title: 'Markdown/InlineColorSwatch',
  argTypes: {
    color: { type: 'color' },
  },
  args: { color: '#228be6' },
  decorators: [
    (Story: React.ComponentType) => (
      <span>
        Use <code>#228be6</code> <Story /> for the accent.
      </span>
    ),
  ],
};

export const Hex = {};
export const RgbaWithAlpha = { args: { color: 'rgba(250, 82, 82, 0.5)' } };
