// Mirrors the server-side prompt substitution in server/src/workflows.ts (runStep).
// Source of truth is the server; keep these two in sync.
export function renderPromptPreview(template: string, task: string, feedback?: string): string {
  const feedbackText = feedback
    ? `\n\nThe user reviewed the previous attempt at this step and asked for changes: ${feedback}`
    : '';
  let prompt = template.includes('{feedback}')
    ? template.replaceAll('{feedback}', feedbackText)
    : template + feedbackText;
  prompt = prompt.replaceAll('{task}', task);
  return prompt;
}
