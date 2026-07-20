import { useEffect, useState } from 'react';
import { Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { AppShell, Box, Center, Stack, Text, Title } from '@mantine/core';
import { IconMessageChatbot } from '@tabler/icons-react';
import { useStore } from './store';
import { Sidebar } from './components/Sidebar';
import { SessionView } from './components/SessionView';
import { ProjectTabs } from './components/ProjectTabs';
import { ProjectPicker } from './components/ProjectPicker';
import { WorkflowEditor } from './components/WorkflowEditor';

const HEADER_HEIGHT = 40;

export function App() {
  return (
    <Routes>
      <Route path="/session/:sessionId" element={<Shell />} />
      <Route path="*" element={<Shell />} />
    </Routes>
  );
}

function Shell() {
  const { sessionId: urlSessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const selectedSessionId = useStore((s) => s.selectedSessionId);
  const selectSession = useStore((s) => s.selectSession);
  const sessions = useStore((s) => s.sessions);
  const projects = useStore((s) => s.projects);
  const activeProject = useStore((s) => s.activeProject);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const [workflowEditorOpen, setWorkflowEditorOpen] = useState(false);

  const hasProjects = projects.length > 0;

  // URL -> store (reload, back/forward, pasted links).
  useEffect(() => {
    const target = urlSessionId ?? null;
    if (target !== useStore.getState().selectedSessionId) selectSession(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSessionId]);

  // store -> URL (session created/auto-selected, deleted, sidebar clicks).
  useEffect(() => {
    if ((urlSessionId ?? null) !== selectedSessionId) {
      navigate(selectedSessionId ? `/session/${selectedSessionId}` : '/');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId]);

  // Selecting a session (URL, auto-select) activates its project tab.
  useEffect(() => {
    const session = selectedSessionId ? sessions[selectedSessionId] : undefined;
    if (session && session.cwd !== activeProject && projects.includes(session.cwd)) {
      setActiveProject(session.cwd);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId, sessions, projects]);

  return (
    <AppShell
      header={{ height: HEADER_HEIGHT }}
      navbar={{
        width: 280,
        breakpoint: 'xs',
        collapsed: { desktop: !hasProjects, mobile: !hasProjects },
      }}
      padding={0}
    >
      <AppShell.Header>
        <ProjectTabs />
      </AppShell.Header>
      <AppShell.Navbar>
        <Sidebar onEditWorkflows={() => setWorkflowEditorOpen(true)} />
      </AppShell.Navbar>
      <AppShell.Main>
        <Box h={`calc(100vh - ${HEADER_HEIGHT}px)`}>
          {!hasProjects ? (
            <ProjectPicker />
          ) : selectedSessionId && sessions[selectedSessionId] ? (
            <SessionView key={selectedSessionId} sessionId={selectedSessionId} />
          ) : (
            <Center h="100%">
              <Stack align="center" gap="xs">
                <IconMessageChatbot size={48} stroke={1.2} opacity={0.4} />
                <Title order={4} c="dimmed">
                  No session selected
                </Title>
                <Text size="sm" c="dimmed">
                  Hit “New session” in the sidebar — it starts right away in{' '}
                  {activeProject?.split('/').filter(Boolean).pop() ?? 'the active project'}.
                </Text>
              </Stack>
            </Center>
          )}
        </Box>
      </AppShell.Main>
      <WorkflowEditor opened={workflowEditorOpen} onClose={() => setWorkflowEditorOpen(false)} />
    </AppShell>
  );
}
