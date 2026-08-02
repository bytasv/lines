import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppShell, Box, Button, Center, Code, Loader, Stack, Text, Title } from '@mantine/core';
import { IconBooks } from '@tabler/icons-react';
import { resolveDocLink } from '@lines/shared';
import { useStore } from '../../store';
import { useDocs } from '../../lib/files';
import { ProjectTabs } from '../ProjectTabs';
import { DocsSidebar } from './DocsSidebar';
import { DocsHome } from './DocsHome';
import { DocView } from './DocView';

const HEADER_HEIGHT = 56;

/**
 * The documentation reader: a dedicated page over the active project's `docs/**`.
 * The whole corpus arrives in one bundle, so the tree, the feature cards, search
 * and doc-to-doc navigation are all local from then on. The URL carries the doc
 * (`/docs/codebase/features/x.md`), which is what makes cross-links plain
 * navigations and the page deep-linkable and reload-safe.
 */
export function DocsPage() {
  const rel = useParams()['*'] ?? '';
  const navigate = useNavigate();
  const activeProject = useStore((s) => s.activeProject);
  const selectedSessionId = useStore((s) => s.selectedSessionId);
  const openFilePreview = useStore((s) => s.openFilePreview);
  const { bundle, error, loading, reload } = useDocs(activeProject);
  const [query, setQuery] = useState('');

  const docs = useMemo(() => bundle?.docs ?? [], [bundle]);
  const docMap = useMemo(() => new Map(docs.map((d) => [d.path, d])), [docs]);

  // Stable by contract: Markdown is memo'd, so a fresh callback per render would
  // re-render the whole rendered document on every keystroke in the search box.
  const onDocLink = useCallback(
    (href: string) => {
      if (!bundle || !activeProject) return;
      const target = resolveDocLink({
        href,
        fromRel: rel,
        docsRoot: bundle.root,
        projectRoot: activeProject,
        hasDoc: (r) => docMap.has(r),
      });
      if (target.kind === 'doc') {
        navigate(`/docs/${target.rel}${target.hash ? `#${target.hash}` : ''}`);
      } else if (target.kind === 'file') {
        openFilePreview(target.abs);
      } else {
        window.open(target.href, '_blank', 'noopener,noreferrer');
      }
    },
    [bundle, activeProject, rel, docMap, navigate, openFilePreview],
  );

  const backToApp = useCallback(() => {
    navigate(selectedSessionId ? `/session/${selectedSessionId}` : '/');
  }, [navigate, selectedSessionId]);

  return (
    <AppShell header={{ height: HEADER_HEIGHT }} navbar={{ width: 300, breakpoint: 'xs' }} padding={0}>
      <AppShell.Header>
        <ProjectTabs />
      </AppShell.Header>
      <AppShell.Navbar>
        <DocsSidebar
          docs={docs}
          selected={rel}
          query={query}
          onQueryChange={setQuery}
          onSelect={(next) => navigate(`/docs/${next}`)}
          onHome={() => navigate('/docs')}
          onBack={backToApp}
        />
      </AppShell.Navbar>
      <AppShell.Main>
        <Box h={`calc(100vh - ${HEADER_HEIGHT}px)`}>
          {loading && !bundle ? (
            <Center h="100%">
              <Loader size="sm" />
            </Center>
          ) : !bundle || !activeProject ? (
            <EmptyState projectRoot={activeProject} error={error} onBack={backToApp} />
          ) : rel ? (
            <DocView
              doc={docMap.get(rel)}
              rel={rel}
              root={bundle.root}
              onDocLink={onDocLink}
              onOpenSource={openFilePreview}
            />
          ) : (
            <DocsHome
              bundle={bundle}
              projectRoot={activeProject}
              loading={loading}
              onOpen={(next) => navigate(`/docs/${next}`)}
              onReload={reload}
            />
          )}
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}

/** No project, or no `docs/` in it — the reader says what it expected to find. */
function EmptyState({
  projectRoot,
  error,
  onBack,
}: {
  projectRoot: string | null;
  error: string | null;
  onBack: () => void;
}) {
  const name = projectRoot?.split('/').filter(Boolean).pop();
  return (
    <Center h="100%" p="xl">
      <Stack align="center" gap="xs" maw={480}>
        <IconBooks size={48} stroke={1.2} opacity={0.4} />
        <Title order={4} c="dimmed">
          {projectRoot ? `No docs/ folder in ${name}` : 'No project open'}
        </Title>
        <Text size="sm" c="dimmed" ta="center">
          {error ?? 'Open a project to read its documentation.'}
        </Text>
        <Text size="sm" c="dimmed" ta="center">
          The reader renders every markdown file under <Code>docs/</Code>, and builds its home page
          from <Code>docs/codebase/index.json</Code>.
        </Text>
        <Button variant="default" size="xs" mt="sm" onClick={onBack}>
          Back to app
        </Button>
      </Stack>
    </Center>
  );
}
