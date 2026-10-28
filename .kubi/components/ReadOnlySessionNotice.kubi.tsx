import { ReadOnlySessionNotice } from '../../web/src/components/ReadOnlySessionNotice';
import { withComposerColumn } from '../decorators';

// Takes the composer's place on a session the installed app runs.
export default {
  component: ReadOnlySessionNotice,
  title: 'Composer/ReadOnlySessionNotice',
  decorators: [withComposerColumn],
};

export const Default = {};
