import { useCallback, useEffect, useState } from 'react';
import { Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { AppShell, Box, Burger, Center, Stack, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconMessageChatbot } from '@tabler/icons-react';
import { useStore } from './store';
import { Sidebar } from './components/Sidebar';
import { SessionView } from './components/SessionView';
import { ProjectTabs } from './components/ProjectTabs';
import { ConnectionBanner } from './components/ConnectionBanner';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SkewBanner } from './components/SkewBanner';
import { StorageBanner } from './components/StorageBanner';
import { WorkerBanner } from './components/WorkerBanner';
import { UpdateBanner } from './components/UpdateBanner';
import { ProjectPicker } from './components/ProjectPicker';
import { WorkflowEditor } from './components/workflow/WorkflowEditor';
import type { WorkflowEditorView } from './components/workflow/WorkflowEditor';
import { MonacoPreviewModal } from './components/MonacoPreviewModal';
import { LoginModal } from './components/LoginModal';
import { OpenaiLoginModal } from './components/OpenaiLoginModal';
import { GuardAllowlistReviewModal } from './components/GuardAllowlistReviewModal';
import { McpConnectionsReviewModal } from './components/McpConnectionsReviewModal';
import { MemoryReviewModal } from './components/MemoryReviewModal';
import { FilePalette } from './components/FilePalette';
import { FilesView } from './components/FilesView';
import { DocsPage } from './components/docs/DocsPage';
import { useIsPhone } from './lib/layout';
import { send } from './ws';

const HEADER_HEIGHT = 56;
const SIDEBAR_MIN = 280;
const SIDEBAR_MAX = 560;
const SIDEBAR_STORAGE_KEY = 'sidebarWidth';

function clampSidebar(w: number) {
  // The viewport is the real upper bound. `window.innerWidth` is read per call
  // rather than captured: a phone rotates, and a desktop window is resized.
  const max = Math.min(SIDEBAR_MAX, Math.max(240, window.innerWidth - 48));
  return Math.min(max, Math.max(Math.min(SIDEBAR_MIN, max), w));
}

export function App() {
  return (
    <>
      <Routes>
        {/* Ranked by specificity in v7, but ordered here to document the intent. */}
        <Route path="/docs/*" element={<DocsPage />} />
        <Route path="/session/:sessionId" element={<Shell />} />
        <Route path="*" element={<Shell />} />
      </Routes>
      {/* Global overlays live outside the routes: the documentation reader opens
          source previews and the sign-in modal too, and they are portalled, so
          AppShell parentage never mattered. The Cmd+P palette is here for the
          same reason — the shortcut works wherever you are. */}
      <FilePalette />
      <MonacoPreviewModal />
      <LoginModal />
      <OpenaiLoginModal />
      <GuardAllowlistReviewModal />
      <McpConnectionsReviewModal />
      <MemoryReviewModal />
    </>
  );
}

function Shell() {
  const { sessionId: urlSessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const selectedSessionId = useStore((s) => s.selectedSessionId);
  const selectSession = useStore((s) => s.selectSession);
  // Per-key, not the whole dict: subscribing to `sessions` re-renders the shell
  // (and everything under it) whenever any other session's metadata changes.
  const selectedSession = useStore((s) => (s.selectedSessionId ? s.sessions[s.selectedSessionId] : undefined));
  const projects = useStore((s) => s.projects);
  const activeProject = useStore((s) => s.activeProject);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const sidebarMode = useStore((s) => s.sidebarMode);
  const [workflowEditorOpen, setWorkflowEditorOpen] = useState(false);
  // Which library the modal lands on — the sidebar has an entry point per library.
  const [workflowEditorView, setWorkflowEditorView] = useState<WorkflowEditorView>('workflows');
  const isPhone = useIsPhone();
  // Real drawer state, rather than the desktop rule reused. On a phone the
  // navbar is the only way to reach another session, so "collapsed" has to mean
  // "closed until asked for" and not "there is no workspace".
  const [navOpen, { toggle: toggleNav, close: closeNav }] = useDisclosure(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem(SIDEBAR_STORAGE_KEY));
    // Clamped against the viewport too: a width saved on a 27" display would
    // otherwise open a 560px drawer over a 390px screen.
    return clampSidebar(saved || SIDEBAR_MIN);
  });
  const [resizing, setResizing] = useState(false);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setResizing(true);
    const onMove = (ev: MouseEvent) => setSidebarWidth(clampSidebar(ev.clientX));
    const onUp = () => {
      setResizing(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setSidebarWidth((w) => {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, String(w));
        return w;
      });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const hasProjects = projects.length > 0;
  /**
   * A guest has no project list — the host's folders are not theirs to open — so
   * `hasProjects` is false and, on its own, would collapse the sidebar and put a
   * folder picker where the shared session should be. What matters is whether
   * there is anything to *show*, which for a guest is the sessions they hold.
   */
  const guest = useStore((s) => s.access !== null);
  const sessionCount = useStore((s) => Object.keys(s.sessions).length);
  const hasWorkspace = hasProjects || (guest && sessionCount > 0);

  const openWorkflowEditor = (view: WorkflowEditorView) => {
    setWorkflowEditorView(view);
    setWorkflowEditorOpen(true);
  };

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

  // Viewing a session clears its post-turn "done" (pulsating green) badge.
  // Covers both clicking a done session and one finishing while already open.
  useEffect(() => {
    if (selectedSession?.status === 'done') {
      send({ type: 'ackSession', sessionId: selectedSession.id });
    }
  }, [selectedSession?.id, selectedSession?.status]);

  // Selecting a session (URL, auto-select) activates its project tab.
  useEffect(() => {
    const cwd = selectedSession?.cwd;
    if (cwd && cwd !== activeProject && projects.some((p) => p.path === cwd)) {
      setActiveProject(cwd);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId, selectedSession?.cwd, projects]);

  return (
    <AppShell
      header={{ height: HEADER_HEIGHT }}
      navbar={{
        width: sidebarWidth,
        breakpoint: 'sm',
        // The two halves mean different things now: on a desktop the navbar is
        // permanent unless there is nothing to show, and on a phone it is a
        // drawer the burger opens.
        collapsed: { desktop: !hasWorkspace, mobile: !hasWorkspace || !navOpen },
      }}
      padding={0}
    >
      <AppShell.Header>
        <Box style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
          {hasWorkspace && (
            <Burger
              opened={navOpen}
              onClick={toggleNav}
              size="sm"
              ml="xs"
              hiddenFrom="sm"
              aria-label="Sessions"
            />
          )}
          <Box style={{ flex: 1, minWidth: 0, height: '100%' }}>
            <ProjectTabs />
          </Box>
        </Box>
      </AppShell.Header>
      <ConnectionBanner headerHeight={HEADER_HEIGHT} />
      <SkewBanner headerHeight={HEADER_HEIGHT} />
      <StorageBanner headerHeight={HEADER_HEIGHT} />
      <WorkerBanner headerHeight={HEADER_HEIGHT} />
      <UpdateBanner headerHeight={HEADER_HEIGHT} />
      <AppShell.Navbar>
        {/* Picking a session on a phone has to close the drawer, or the thing
            just picked is behind it. */}
        <Sidebar
          onEditWorkflows={() => openWorkflowEditor('workflows')}
          onBrowseRecipes={() => openWorkflowEditor('recipes')}
          onNavigate={isPhone ? closeNav : undefined}
        />
        {hasWorkspace && !isPhone && (
          <Box
            onMouseDown={startResize}
            className="sidebar-resize-handle"
            data-resizing={resizing || undefined}
          />
        )}
      </AppShell.Navbar>
      <AppShell.Main>
        <Box h={`calc(100vh - ${HEADER_HEIGHT}px)`}>
          {!hasWorkspace ? (
            // A guest cannot open a project on somebody else's machine, so the
            // picker would be a dead end offering an action they do not have.
            guest ? (
              <Center h="100%">
                <Stack align="center" gap="xs" maw={420}>
                  <IconMessageChatbot size={48} stroke={1.2} opacity={0.4} />
                  <Title order={4} c="dimmed">
                    Nothing shared with you yet
                  </Title>
                  <Text size="sm" c="dimmed" ta="center">
                    When someone shares a session on this machine it appears here.
                  </Text>
                </Stack>
              </Center>
            ) : (
              <ProjectPicker />
            )
          ) : sidebarMode === 'files' ? (
            <FilesView />
          ) : selectedSessionId && selectedSession ? (
            <ErrorBoundary key={selectedSessionId}>
              <SessionView sessionId={selectedSessionId} />
            </ErrorBoundary>
          ) : (
            <Center h="100%">
              <Stack align="center" gap="xs">
                <IconMessageChatbot size={48} stroke={1.2} opacity={0.4} />
                <Title order={4} c="dimmed">
                  No session selected
                </Title>
                <Text size="sm" c="dimmed">
                  {guest
                    ? 'Pick a shared session from the sidebar.'
                    : `Hit “New session” in the sidebar — it starts right away in ${
                        activeProject?.split('/').filter(Boolean).pop() ?? 'the active project'
                      }.`}
                </Text>
              </Stack>
            </Center>
          )}
        </Box>
      </AppShell.Main>
      <WorkflowEditor
        opened={workflowEditorOpen}
        initialView={workflowEditorView}
        onClose={() => setWorkflowEditorOpen(false)}
      />
    </AppShell>
  );
}
