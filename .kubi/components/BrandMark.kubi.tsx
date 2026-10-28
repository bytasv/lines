import { BrandMark } from '../../web/src/components/BrandMark';

export default {
  component: BrandMark,
  title: 'Brand/BrandMark',
  argTypes: {
    height: { type: 'number' },
  },
  args: { height: 24 },
};

export const Header = {};
export const Large = { args: { height: 48 } };
