import { QuestionReview } from '../../web/src/components/QuestionPrompt';

export default {
  component: QuestionReview,
  title: 'Transcript/QuestionReview',
  argTypes: {
    input: { type: 'object' },
    result: { type: 'string' },
  },
  args: {
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
      ],
    },
    result: 'User has answered your questions: "How long should the reconnect delay be allowed to grow?"="30 seconds".',
  },
  decorators: [(Story: React.ComponentType) => <div style={{ maxWidth: 720 }}><Story /></div>],
};

export const Answered = {};
export const Unanswered = { args: { result: undefined } };
