import { MarkdownImage, MarkdownLinkContent } from '../../web/src/components/MarkdownImage';

export default {
  component: MarkdownLinkContent,
  title: 'Markdown/MarkdownLinkContent',
  argTypes: {
    children: { type: 'slot' },
  },
  slots: ['children'],
};

/** A README badge: the image is the link's label, so it renders as a plain chip. */
export const BadgeInLink = {
  render: () => (
    <a href="https://github.com/example/lines/actions">
      <MarkdownLinkContent>
        <MarkdownImage src="https://img.shields.io/badge/build-passing-green" alt="build passing" />
      </MarkdownLinkContent>
    </a>
  ),
};
