import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, Center, Code, Stack, Text, Title } from '@mantine/core';

/**
 * Keeps one bad render from blanking the whole app. Scoped per session (keyed on
 * the session id by the caller) so switching sessions clears the error state.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('render failed', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Center h="100%" p="md">
        <Stack align="center" gap="xs" maw={640}>
          <Title order={4}>This session failed to render</Title>
          <Code block style={{ maxHeight: 200, overflow: 'auto' }}>
            {error.message}
          </Code>
          <Text size="sm" c="dimmed">
            Other sessions still work — pick one in the sidebar, or reload.
          </Text>
          <Button variant="light" size="xs" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        </Stack>
      </Center>
    );
  }
}
