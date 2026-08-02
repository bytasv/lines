import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import type { DocsResponse } from '@lines/shared';
import { invalidateFeatures, loadFeatures, type FeatureEntry } from '../../lib/features';
import { featureCards, unindexedDocs } from '../../lib/docs';

interface DocsHomeProps {
  bundle: DocsResponse;
  projectRoot: string;
  loading: boolean;
  onOpen: (rel: string) => void;
  onReload: () => void;
}

/**
 * The reader's landing page: one card per `docs/codebase/index.json` feature,
 * then every doc the index doesn't claim. The corpus and the index drift apart
 * in practice, so both directions of skew are shown rather than reconciled.
 */
export function DocsHome({ bundle, projectRoot, loading, onOpen, onReload }: DocsHomeProps) {
  const [features, setFeatures] = useState<FeatureEntry[] | null>(null);
  const [featureKey, setFeatureKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void loadFeatures(projectRoot).then((f) => {
      if (!cancelled) setFeatures(f);
    });
    return () => {
      cancelled = true;
    };
  }, [projectRoot, featureKey]);

  const cards = useMemo(() => {
    const paths = new Set(bundle.docs.map((d) => d.path));
    return featureCards(features ?? [], (rel) => paths.has(rel));
  }, [features, bundle]);
  const others = useMemo(() => unindexedDocs(bundle.docs, cards), [bundle, cards]);

  const refresh = useCallback(() => {
    invalidateFeatures(projectRoot);
    setFeatureKey((k) => k + 1);
    onReload();
  }, [projectRoot, onReload]);

  const name = projectRoot.split('/').filter(Boolean).pop();

  return (
    <ScrollArea h="100%" type="hover">
      <Stack gap="md" p="lg">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2}>
            <Title order={3}>{name} documentation</Title>
            <Text size="xs" c="dimmed">
              {bundle.docs.length} document{bundle.docs.length === 1 ? '' : 's'} under docs/
            </Text>
          </Stack>
          <Button
            size="xs"
            variant="default"
            leftSection={<IconRefresh size={14} />}
            loading={loading}
            onClick={refresh}
          >
            Refresh
          </Button>
        </Group>

        {bundle.truncated && (
          <Alert color="yellow" icon={<IconAlertTriangle size={16} />} title="Partial corpus">
            This docs folder is larger than the reader loads in one go — some files are missing from
            the tree and from search.
          </Alert>
        )}

        {features === null ? (
          <Alert color="gray" title="No feature index">
            <Text size="sm">
              docs/codebase/index.json is missing or unreadable, so there are no feature cards. Every
              document is still listed below.
            </Text>
          </Alert>
        ) : (
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
            {cards.map((card) => (
              <Card
                key={card.id}
                withBorder
                padding="sm"
                style={{ cursor: card.rel ? 'pointer' : 'default' }}
                onClick={() => card.rel && onOpen(card.rel)}
              >
                <Group justify="space-between" wrap="nowrap" gap="xs">
                  <Text fw={600} size="sm" truncate>
                    {card.name}
                  </Text>
                  {!card.rel && (
                    <Badge size="xs" variant="light" color="gray">
                      no doc
                    </Badge>
                  )}
                </Group>
                {card.purpose && (
                  <Text size="xs" c="dimmed" lineClamp={3} mt={4}>
                    {card.purpose}
                  </Text>
                )}
                {card.entryPoints.length > 0 && (
                  <Text size="xs" c="dimmed" mt={6}>
                    {card.entryPoints.length} entry point
                    {card.entryPoints.length === 1 ? '' : 's'}
                  </Text>
                )}
              </Card>
            ))}
          </SimpleGrid>
        )}

        {others.length > 0 && (
          <Stack gap={4}>
            <Text size="xs" fw={600} c="dimmed" tt="uppercase">
              {features === null ? 'All documents' : 'Other documents'}
            </Text>
            {others.map((doc) => (
              <Card
                key={doc.path}
                withBorder
                padding="xs"
                style={{ cursor: 'pointer' }}
                onClick={() => onOpen(doc.path)}
              >
                <Text size="sm" fw={500} truncate>
                  {doc.title}
                </Text>
                <Text size="xs" c="dimmed" truncate>
                  {doc.path}
                </Text>
                {doc.summary && (
                  <Text size="xs" c="dimmed" lineClamp={2} mt={2}>
                    {doc.summary}
                  </Text>
                )}
              </Card>
            ))}
          </Stack>
        )}

        <Text size="xs" c="dimmed">
          The index is a navigation aid and may be stale — the source is authoritative.
        </Text>
      </Stack>
    </ScrollArea>
  );
}
