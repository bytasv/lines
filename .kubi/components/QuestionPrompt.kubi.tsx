import { QuestionPrompt } from '../../web/src/components/QuestionPrompt';
import { withSessionStore } from '../decorators';
import { SESSION_WAITING } from '../fixtures';

const question = {
  requestId: 'perm_fx_question',
  toolName: 'AskUserQuestion',
  input: {
    questions: [
      {
        header: 'Backoff cap',
        question: 'How long should the reconnect delay be allowed to grow?',
        options: [
          { label: '30 seconds', description: 'Recovers quickly after a laptop wakes' },
          { label: '60 seconds', description: 'What it does today' },
          { label: '5 minutes', description: 'Gentlest on the relay during an outage' },
        ],
      },
      {
        header: 'Scope',
        question: 'Which close codes should reset the attempt counter?',
        multiSelect: true,
        options: [
          { label: '1000 normal' },
          { label: '1001 going away' },
          { label: '1008 policy violation' },
        ],
      },
    ],
  },
};

export default {
  component: QuestionPrompt,
  title: 'Transcript/QuestionPrompt',
  argTypes: {
    sessionId: { type: 'string' },
    data: { type: 'object' },
    resolution: { control: 'select', options: [undefined, 'allow', 'deny', 'expired'] },
  },
  args: {
    sessionId: SESSION_WAITING.id,
    data: question,
  },
  decorators: [withSessionStore, (Story: React.ComponentType) => <div style={{ maxWidth: 720 }}><Story /></div>],
};

export const Pending = {};
export const Answered = {
  args: {
    resolution: 'allow',
    data: {
      ...question,
      answers: {
        'How long should the reconnect delay be allowed to grow?': '30 seconds',
        'Which close codes should reset the attempt counter?': '1000 normal, 1001 going away',
      },
    },
  },
};
export const Expired = { args: { resolution: 'expired' } };
