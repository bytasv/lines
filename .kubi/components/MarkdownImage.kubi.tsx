import { MarkdownImage } from '../../web/src/components/MarkdownImage';

export default {
  component: MarkdownImage,
  title: 'Markdown/MarkdownImage',
  argTypes: {
    src: { type: 'string' },
    alt: { type: 'string' },
    onLinkClick: { action: 'link clicked' },
  },
  args: { src: 'https://example.com/screenshots/settings.png', alt: 'Settings screenshot' },
};

export const RemoteUrl = {};
export const FilePath = { args: { src: 'docs/images/pairing.png', alt: 'Pairing diagram' } };
export const NoSource = { args: { src: undefined, alt: 'Missing image' } };
