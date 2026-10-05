import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { AppShell, Box, Burger, Center, Loader, Stack, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconMessageChatbot } from '@tabler/icons-react';
import { useStore } from './store';
import { inProject } from './lib/machines';
import { Sidebar } from './components/Sidebar';
import { SessionView } from './components/SessionView';
import { ProjectTabs } from './components/ProjectTabs';
import { ConnectionBanner } from './components/ConnectionBanner';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SkewBanner } from './components/SkewBanner';
import { StorageBanner } from './components/StorageBanner';
import { WorkerBanner } from './components/WorkerBanner';
import { UpdateBanner } from './components/UpdateBanner';
import { DesktopUpdateWhatsNew } from './components/WhatsNewModal';
import { ProjectPicker } from './components/ProjectPicker';
import { WorkflowEditor } from './components/workflow/WorkflowEditor';
import type { WorkflowEditorView } from './components/workflow/WorkflowEditor';
import { LoginModal } from './components/LoginModal';
import { OpenaiLoginModal } from './components/OpenaiLoginModal';
import { GuardAllowlistReviewModal } from './components/GuardAllowlistReviewModal';
import { McpConnectionsReviewModal } from './components/McpConnectionsReviewModal';
import { MemoryReviewModal } from './components/MemoryReviewModal';
import { FilePalette } from './components/FilePalette';
import { DocsPage } from './components/docs/DocsPage';
import { useIsPhone } from './lib/layout';
import { send } from './ws';

/**
 * The two editor surfaces reachable from here, split out of the entry chunk.
 *
 * Monaco is several megabytes, and a static import anywhere in this graph puts
 * all of it in front of the first paint — for every screen, including the ones
 * with no editor on them. Lazy, they are fetched when a file or a diff is
 * actually opened. Each of these modules imports `lib/monacoSetup` itself, so
 * the CDN override still runs before the editor mounts.
 */
const FilesView = lazy(() => import('./components/FilesView').then((m) => ({ default: m.FilesView })));
const SearchPreviewView = lazy(() =>
  import('./components/FilesView').then((m) => ({ default: m.SearchPreviewView })),
);
const MonacoPreviewModal = lazy(() =>
  import('./components/MonacoPreviewModal').then((m) => ({ default: m.MonacoPreviewModal })),
);

// The visible bar, and the header box it sits in: in a standalone iOS app the
// header also reaches up under the status bar.
const HEADER_BAR = 56;
const HEADER_HEIGHT = `calc(${HEADER_BAR}px + var(--lines-safe-top))`;
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
  // Subscribed to as a boolean so the lazy chunk is requested when a preview is
  // opened and not before — mounting the modal unconditionally would fetch
  // Monaco on every boot, which is the thing this split exists to avoid.
  const previewOpen = useStore((s) => s.filePreview !== null);
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
      {/* A desktop update that arrived mid-session; one at boot shows on the splash (main.tsx). */}
      <DesktopUpdateWhatsNew />
      {previewOpen && (
        <Suspense fallback={null}>
          <MonacoPreviewModal />
        </Suspense>
      )}
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
  const projectKeys = useStore((s) => s.projectKeys);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const sidebarMode = useStore((s) => s.sidebarMode);
  const hasSearchPreview = useStore((s) => s.searchPreview !== null);
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

  // Selecting a session (URL, auto-select) activates its project tab. Key-aware,
  // like the sidebar's `sessionsInProject`: a work-tree or extra-root session's
  // cwd is not the tab's path, yet it belongs to that tab.
  useEffect(() => {
    if (!selectedSession?.cwd) return;
    const current = projects.find((p) => p.path === activeProject);
    if (current && inProject(selectedSession, projectKeys, current)) return;
    const owner = projects.find((p) => inProject(selectedSession, projectKeys, p));
    if (owner) setActiveProject(owner.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId, selectedSession?.cwd, projects, projectKeys]);

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
      <AppShell.Header className="lines-safe-top">
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
      <ConnectionBanner headerHeight={HEADER_BAR} />
      <SkewBanner headerHeight={HEADER_BAR} />
      <StorageBanner headerHeight={HEADER_BAR} />
      <WorkerBanner headerHeight={HEADER_BAR} />
      <UpdateBanner headerHeight={HEADER_BAR} />
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
        {/* `--lines-viewport`, not `100vh`: on a phone they differ by the
            browser toolbar and by the keyboard, and the composer lives at the
            bottom of this box. See lib/viewport.ts. */}
        <Box h={`calc(var(--lines-viewport) - ${HEADER_HEIGHT})`}>
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
            <Suspense
              fallback={
                <Center h="100%">
                  <Loader />
                </Center>
              }
            >
              <FilesView />
            </Suspense>
          ) : hasSearchPreview ? (
            // A file-search hit: shown here so the sidebar keeps the results.
            <Suspense
              fallback={
                <Center h="100%">
                  <Loader />
                </Center>
              }
            >
              <SearchPreviewView />
            </Suspense>
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
