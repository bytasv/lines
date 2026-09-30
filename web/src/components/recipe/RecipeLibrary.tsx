import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  Group,
  Paper,
  Popover,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconCopy,
  IconGripVertical,
  IconHistory,
  IconPlayerPlay,
  IconPlus,
  IconStack2,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { DragDropContext, Draggable, Droppable } from '@hello-pangea/dnd';
import type { DropResult } from '@hello-pangea/dnd';
import type { RecipeContent, RecipeDef, RecipeRef } from '@lines/shared';
import { RECIPE_BUNDLE_MAX, RECIPE_TAG_MAX, isBundle, normalizeRecipeTag } from '@lines/shared';
import { useStore } from '../../store';
import { getOwnerId, getOwnerName } from '../../lib/clerk';
import { send } from '../../ws';
import { ConfirmModal } from '../ConfirmModal';
import { relTime } from '../workflow/StepCard';
import styles from '../workflow/workflow.module.css';
import { RecipeImages } from './RecipeImages';
import { RecipeRunModal } from './RecipeRunModal';

type Draft = RecipeContent & {
  id?: string;
  ownerId?: string;
  ownerName?: string;
  version?: number;
  published?: boolean;
};

type Kind = 'prompt' | 'bundle';

const BLANK: Draft = {
  title: 'New recipe',
  description: '',
  tags: [],
  images: [],
  prompt: '',
  published: false,
};

/** How many tag chips stay in the row; the rest hide behind "+N more". */
const VISIBLE_TAG_CHIPS = 12;

/**
 * "Is a bundle" reads like a tag while browsing, but it is not one — the ':' is
 * stripped by `normalizeRecipeTag`, so this sentinel can never collide with a
 * tag someone actually stored.
 */
const BUNDLE_FILTER = ':bundle';

function keyOf(r: { ownerId: string; id: string }): string {
  return `${r.ownerId}/${r.id}`;
}

/** Dirty/baseline key — content plus the published flag (a publish toggle is a change). */
function snapshot(d: Draft): string {
  return JSON.stringify({ ...content(d), published: d.published ?? false });
}

function content(d: Draft): RecipeContent {
  const base = { title: d.title, description: d.description, tags: d.tags, images: d.images };
  // Exactly one of prompt/members is populated; the server re-checks this.
  return (d.members?.length ?? 0) > 0
    ? { ...base, prompt: '', members: d.members }
    : { ...base, prompt: d.prompt };
}

/** Per-field diff of two recipe contents (red − / teal +), the recipe twin of `FieldDiffList`. */
function RecipeDiffList({ from, to }: { from: RecipeContent; to: RecipeContent }) {
  const rows: [string, string, string][] = [
    ['Title', from.title, to.title],
    ['Description', from.description, to.description],
    ['Tags', from.tags.join(', '), to.tags.join(', ')],
    ['Prompt', from.prompt, to.prompt],
    ['Members', String(from.members?.length ?? 0), String(to.members?.length ?? 0)],
    ['Screenshots', String(from.images.length), String(to.images.length)],
  ].filter(([, a, b]) => a !== b) as [string, string, string][];
  if (rows.length === 0) return <Text size="xs" c="dimmed">No field changes.</Text>;
  return (
    <ScrollArea.Autosize mah={280} type="auto">
      <Stack gap={10}>
        {rows.map(([label, a, b]) => (
          <Stack key={label} gap={2}>
            <Text size="xs" fw={600} c="dimmed">{label}</Text>
            <Text size="xs" c="red" style={{ whiteSpace: 'pre-wrap' }}>- {a || '(empty)'}</Text>
            <Text size="xs" c="teal" style={{ whiteSpace: 'pre-wrap' }}>+ {b || '(empty)'}</Text>
          </Stack>
        ))}
      </Stack>
    </ScrollArea.Autosize>
  );
}

/**
 * A bundle's ordered members. Module-scope (unlike the row renderers) because a
 * re-created component type would remount `DragDropContext` and lose an
 * in-flight drag.
 */
function MemberList({
  members,
  resolve,
  readOnly,
  onDragEnd,
  onRemove,
  onJump,
}: {
  members: RecipeRef[];
  resolve: (ref: RecipeRef) => RecipeDef | undefined;
  readOnly: boolean;
  onDragEnd: (result: DropResult) => void;
  onRemove: (index: number) => void;
  onJump: (def: RecipeDef) => void;
}) {
  const Row = ({ ref_, index }: { ref_: RecipeRef; index: number }) => {
    const def = resolve(ref_);
    return (
      <Paper withBorder radius="md" p="xs">
        <Group gap={8} wrap="nowrap">
          <Text size="xs" c="dimmed" w={16}>{index + 1}</Text>
          <UnstyledButton
            style={{ flex: 1, minWidth: 0, textAlign: 'left' }}
            disabled={!def}
            onClick={() => def && onJump(def)}
          >
            <Text size="sm" truncate>{def?.title ?? 'Unavailable recipe'}</Text>
            <Text fz={10} c="dimmed" truncate>{def?.ownerName ?? 'Unknown'}</Text>
          </UnstyledButton>
          {def && !def.published && (
            <Badge size="xs" variant="light" color="yellow">unpublished</Badge>
          )}
          {!readOnly && (
            <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => onRemove(index)}>
              <IconX size={13} />
            </ActionIcon>
          )}
        </Group>
      </Paper>
    );
  };

  if (readOnly) {
    return (
      <Stack gap={6}>
        {members.map((m, i) => (
          <Row key={`${m.ownerId}/${m.recipeId}`} ref_={m} index={i} />
        ))}
      </Stack>
    );
  }

  return (
    <DragDropContext onDragEnd={onDragEnd}>
      <Droppable droppableId="members">
        {(dropProvided) => (
          <Stack gap={6} ref={dropProvided.innerRef} {...dropProvided.droppableProps}>
            {members.map((m, i) => (
              <Draggable key={`${m.ownerId}/${m.recipeId}`} draggableId={`${m.ownerId}/${m.recipeId}`} index={i}>
                {(dragProvided) => (
                  <div ref={dragProvided.innerRef} {...dragProvided.draggableProps}>
                    <Group gap={4} wrap="nowrap" align="center">
                      <span {...dragProvided.dragHandleProps} style={{ display: 'flex', cursor: 'grab' }}>
                        <IconGripVertical size={14} opacity={0.5} />
                      </span>
                      <Box style={{ flex: 1, minWidth: 0 }}>
                        <Row ref_={m} index={i} />
                      </Box>
                    </Group>
                  </div>
                )}
              </Draggable>
            ))}
            {dropProvided.placeholder}
          </Stack>
        )}
      </Droppable>
    </DragDropContext>
  );
}

/**
 * Browse an owned recipe's version history and restore one. Restoring loads that
 * version into the draft (leaving it dirty); Save republishes it as a *new* head
 * version — history is never rewritten. `versions === undefined` = still loading.
 */
function RestoreHistoryPopover({
  current,
  currentVersion,
  versions,
  onOpen,
  onRestore,
}: {
  current: RecipeContent;
  currentVersion?: number;
  versions?: RecipeDef[];
  onOpen: () => void;
  onRestore: (def: RecipeDef) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const preview = versions?.find((v) => v.version === selected);

  return (
    <Popover
      width="min(340px, calc(100vw - 2rem))"
      position="bottom-end"
      withArrow
      shadow="md"
      opened={opened}
      onChange={setOpened}
    >
      <Popover.Target>
        <Tooltip label="Version history">
          <ActionIcon
            variant="subtle"
            color="gray"
            mb={4}
            onClick={() => {
              // Fire the fetch here — Mantine's onChange doesn't fire when we drive `opened` ourselves.
              if (!opened) {
                setSelected(null);
                onOpen();
              }
              setOpened((o) => !o);
            }}
          >
            <IconHistory size={16} />
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap={10}>
          <Text size="xs" fw={600}>Version history</Text>
          {versions === undefined ? (
            <Text size="xs" c="dimmed">Loading versions…</Text>
          ) : (
            <>
              <ScrollArea.Autosize mah={220} type="auto">
                <Stack gap={1}>
                  {versions.map((v) => (
                    <UnstyledButton
                      key={v.version}
                      className={`${styles.versionRow} ${selected === v.version ? styles.versionRowActive : ''}`}
                      onClick={() => setSelected(v.version)}
                    >
                      <Text size="sm" fw={600}>v{v.version}</Text>
                      <Text size="xs" c="dimmed" style={{ flex: 1, minWidth: 0 }} truncate>{relTime(v.updatedAt)}</Text>
                      {v.version === currentVersion && (
                        <Badge size="xs" variant="light">current</Badge>
                      )}
                    </UnstyledButton>
                  ))}
                </Stack>
              </ScrollArea.Autosize>
              {preview && (
                <>
                  <RecipeDiffList from={current} to={preview} />
                  <Button
                    size="xs"
                    disabled={preview.version === currentVersion}
                    onClick={() => {
                      onRestore(preview);
                      setOpened(false);
                    }}
                  >
                    Restore v{preview.version}
                  </Button>
                </>
              )}
            </>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

export function RecipeLibrary({
  /** Dismiss the surrounding browser once a run starts — the new session is what
   *  the user wants to see, and it is behind this modal. */
  onRan,
}: {
  onRan?: () => void;
} = {}) {
  const recipes = useStore((s) => s.recipes);
  const sharedRecipes = useStore((s) => s.sharedRecipes);
  const recipeVersions = useStore((s) => s.recipeVersions);
  const recipeStats = useStore((s) => s.recipeStats);

  // Selected key: `own:<id>` | `shared:<ownerId>/<id>` | null (creating new).
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>('prompt');
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Where a member jump came from, so a bundle's detail pane has a way back. */
  const [backTo, setBackTo] = useState<{ key: string; title: string } | null>(null);
  // Browse filters are deliberately local: they are a way of looking, not a setting.
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  /** Ad-hoc run basket, keyed `ownerId/id` so it survives filtering and re-sorting. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [runList, setRunList] = useState<RecipeDef[] | null>(null);

  const corpus = useMemo(() => [...recipes, ...sharedRecipes], [recipes, sharedRecipes]);

  const load = (d: Draft | null, key: string | null) => {
    setDraft(d);
    setSelected(key);
    setBaseline(d ? snapshot(d) : null);
    setKind(d && isBundle(d) ? 'bundle' : 'prompt');
  };

  // On first mount (or when the lists arrive), pick the first owned recipe.
  useEffect(() => {
    if (draft) return;
    if (recipes[0]) load(recipes[0], `own:${recipes[0].id}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipes.length]);

  const readOnly = !!draft && selected?.startsWith('shared:') === true;
  const dirty = useMemo(() => (draft && baseline ? snapshot(draft) !== baseline : false), [draft, baseline]);
  const memberCount = draft?.members?.length ?? 0;
  const valid =
    !!draft &&
    draft.title.trim() !== '' &&
    (kind === 'bundle'
      ? memberCount >= 2 && memberCount <= RECIPE_BUNDLE_MAX
      : draft.prompt.trim() !== '');

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  // ---- tag vocabulary + filtering ----

  /** Tag frequency across everything visible to this user, most used first. */
  const tagOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of corpus) {
      for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const options = [...counts.entries()]
      .map(([value, count]) => ({ value, label: value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    const bundles = corpus.filter((r) => isBundle(r)).length;
    return bundles > 0
      ? [{ value: BUNDLE_FILTER, label: 'bundle', count: bundles }, ...options]
      : options;
  }, [corpus]);

  const corpusTags = useMemo(() => tagOptions.filter((t) => t.value !== BUNDLE_FILTER).map((t) => t.value), [tagOptions]);

  // A selected chip is pinned into the visible row: hiding the control the user
  // just clicked (because the option set shifted) makes the filter feel unstable.
  const visibleTags = useMemo(() => {
    const head = tagOptions.slice(0, VISIBLE_TAG_CHIPS);
    const pinned = tagOptions.filter((t) => tagFilter.includes(t.value) && !head.includes(t));
    return [...head, ...pinned];
  }, [tagOptions, tagFilter]);
  const overflowTags = useMemo(
    () => tagOptions.filter((t) => !visibleTags.includes(t)),
    [tagOptions, visibleTags],
  );

  const matches = (r: RecipeDef) => {
    // Tags are OR'd (browsing widens), then AND'd with the text search.
    const tagOk =
      tagFilter.length === 0 ||
      tagFilter.some((t) => (t === BUNDLE_FILTER ? isBundle(r) : r.tags.includes(t)));
    const q = query.trim().toLowerCase();
    const textOk =
      !q || r.title.toLowerCase().includes(q) || r.description.toLowerCase().includes(q);
    return tagOk && textOk;
  };

  const ownList = recipes.filter(matches);
  const sharedList = sharedRecipes.filter(matches);

  // ---- version history (own recipes only) ----
  const ownerIdOf = (d: Draft) => d.ownerId ?? getOwnerId() ?? '';

  const requestVersions = () => {
    if (!draft?.id) return;
    send({ type: 'recipeVersions', ownerId: ownerIdOf(draft), recipeId: draft.id });
  };

  /** Fetched history unioned with the local head, newest first; undefined = nothing known yet. */
  const versionsFor = (d: Draft): RecipeDef[] | undefined => {
    if (!d.id) return undefined;
    const fetched = recipeVersions[`${ownerIdOf(d)}/${d.id}`];
    const head = recipes.find((r) => r.id === d.id);
    if (!fetched && !head) return undefined;
    const byVersion = new Map<number, RecipeDef>();
    for (const v of [...(fetched ?? []), ...(head ? [head] : [])]) {
      if (!byVersion.has(v.version)) byVersion.set(v.version, v);
    }
    return [...byVersion.values()].sort((a, b) => b.version - a.version);
  };

  const restore = (def: RecipeDef) => patch(content(def));

  // ---- selection / navigation ----

  const selectionKeyOf = (r: RecipeDef) =>
    recipes.some((own) => own.id === r.id) ? `own:${r.id}` : `shared:${keyOf(r)}`;

  const resolve = (ref: RecipeRef) =>
    corpus.find((r) => r.ownerId === ref.ownerId && r.id === ref.recipeId);

  /** The saved head of the open recipe — a run resolves ids server-side, so unsaved edits never ride along. */
  const openDef = draft?.id ? corpus.find((r) => r.id === draft.id) : undefined;

  /** Follow a bundle member; the basket and the filters stay put by design. */
  const jumpTo = (r: RecipeDef) => {
    if (draft && selected) setBackTo({ key: selected, title: draft.title });
    load(r, selectionKeyOf(r));
  };

  const goBack = () => {
    if (!backTo) return;
    const target = corpus.find((r) => selectionKeyOf(r) === backTo.key);
    setBackTo(null);
    if (target) load(target, backTo.key);
  };

  const togglePicked = (k: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  /** Basket order is tick order — a Set keeps insertion order, which is what the run uses. */
  const pickedDefs = () =>
    [...picked].map((k) => corpus.find((r) => keyOf(r) === k)).filter((r): r is RecipeDef => !!r);

  const newRecipe = () => {
    setBackTo(null);
    load({ ...BLANK }, null);
  };

  const save = () => {
    if (!draft || readOnly || !valid) return;
    const recipeId = draft.id ?? crypto.randomUUID();
    const published = draft.published ?? false;
    send({ type: 'saveRecipe', recipe: content(draft), recipeId, published, ownerName: getOwnerName() ?? undefined });
    // Select the (soon-updated) own recipe; the broadcast refreshes its version.
    load({ ...draft, id: recipeId, published }, `own:${recipeId}`);
  };

  const duplicate = () => {
    if (!draft) return;
    setBackTo(null);
    load({ ...content(draft), title: `${draft.title} (copy)` }, null);
  };

  const doDelete = () => {
    setConfirmDelete(false);
    if (!draft?.id) return;
    send({ type: 'deleteRecipe', recipeId: draft.id });
    load(recipes.find((r) => r.id !== draft.id) ?? null, null);
  };

  /** Turn the current ad-hoc selection into an unsaved composite recipe. */
  const saveSelectionAsBundle = (list: RecipeDef[]) => {
    setRunList(null);
    setBackTo(null);
    load(
      {
        ...BLANK,
        title: list[0] ? `${list[0].title} kit` : 'New bundle',
        members: list.map((r) => ({ ownerId: r.ownerId, recipeId: r.id })),
      },
      null,
    );
  };

  const onMemberDragEnd = (result: DropResult) => {
    if (!result.destination || !draft?.members) return;
    const next = [...draft.members];
    next.splice(result.destination.index, 0, ...next.splice(result.source.index, 1));
    patch({ members: next });
  };

  /** Read-only tag chips; clicking one browses by it. */
  const TagChips = ({ tags, bundle }: { tags: string[]; bundle?: boolean }) => (
    <Group gap={4} wrap="wrap">
      {bundle && (
        <Badge size="xs" variant="light" component="span" style={{ cursor: 'pointer' }} onClick={(e) => {
          e.stopPropagation();
          setTagFilter([BUNDLE_FILTER]);
        }}>
          bundle
        </Badge>
      )}
      {tags.map((t) => (
        <Badge
          key={t}
          size="xs"
          variant="default"
          component="span"
          style={{ cursor: 'pointer' }}
          onClick={(e) => {
            e.stopPropagation();
            setTagFilter([t]);
          }}
        >
          {t}
        </Badge>
      ))}
    </Group>
  );

  const RecipeRow = ({ def, shared }: { def: RecipeDef; shared: boolean }) => {
    const k = shared ? `shared:${keyOf(def)}` : `own:${def.id}`;
    const runs = recipeStats[keyOf(def)] ?? 0;
    const bundle = isBundle(def);
    const atCap = picked.size >= RECIPE_BUNDLE_MAX && !picked.has(keyOf(def));
    return (
      <Group gap={6} wrap="nowrap" align="center">
        <Tooltip label={`At most ${RECIPE_BUNDLE_MAX} recipes run together`} disabled={!atCap}>
          <Checkbox
            size="xs"
            checked={picked.has(keyOf(def))}
            disabled={atCap}
            onChange={() => togglePicked(keyOf(def))}
          />
        </Tooltip>
        <Button
          variant={selected === k ? 'light' : 'subtle'}
          color="gray"
          justify="start"
          h="auto"
          py={6}
          style={{ flex: 1, minWidth: 0 }}
          onClick={() => {
            setBackTo(null);
            load(def, k);
          }}
        >
          <Stack gap={2} style={{ minWidth: 0, width: '100%' }}>
            <Group gap={6} wrap="nowrap" justify="space-between">
              <Text size="xs" truncate>{def.title}</Text>
              <Group gap={4} wrap="nowrap">
                {bundle && (
                  <Badge size="xs" variant="light" color="gray" leftSection={<IconStack2 size={10} />}>
                    {def.members?.length ?? 0} recipes
                  </Badge>
                )}
                {runs > 0 && (
                  <Badge size="xs" variant="default" leftSection={<IconPlayerPlay size={9} />}>
                    {runs}
                  </Badge>
                )}
                {!shared && <Badge size="xs" variant="default">v{def.version}</Badge>}
              </Group>
            </Group>
            {shared && (
              <Text fz={10} c="dimmed" truncate>{def.ownerName ?? 'Unknown'} · v{def.version}</Text>
            )}
            {def.tags.length > 0 && <TagChips tags={def.tags} />}
          </Stack>
        </Button>
      </Group>
    );
  };

  /** Leaves only — the server rejects nested bundles, so they are never offered. */
  const memberCandidates = corpus
    .filter((r) => !isBundle(r))
    .filter((r) => r.id !== draft?.id)
    .filter((r) => !(draft?.members ?? []).some((m) => m.ownerId === r.ownerId && m.recipeId === r.id))
    .map((r) => ({ value: keyOf(r), label: `${r.title} · ${r.ownerName ?? 'Unknown'}` }));

  const unpublishedMembers = (draft?.members ?? [])
    .map(resolve)
    .filter((r) => r && !r.published).length;

  return (
    <Group align="stretch" gap={0} wrap="nowrap" style={{ flex: 1, minHeight: 0 }}>
      <Box p="md" style={{ display: 'flex' }}>
        <Stack gap="xs" w={240} style={{ flexShrink: 0 }} h="100%">
          <TextInput
            size="xs"
            placeholder="Search recipes…"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
          {tagOptions.length > 0 && (
            <Chip.Group multiple value={tagFilter} onChange={setTagFilter}>
              <Group gap={4} wrap="wrap">
                {visibleTags.map((t) => (
                  <Chip key={t.value} value={t.value} size="xs" variant="light">
                    {t.label} {t.count}
                  </Chip>
                ))}
                {overflowTags.length > 0 && (
                  <Popover width={260} position="bottom-start" withArrow shadow="md">
                    <Popover.Target>
                      <Button size="compact-xs" variant="subtle" color="gray">
                        +{overflowTags.length} more
                      </Button>
                    </Popover.Target>
                    <Popover.Dropdown>
                      <Group gap={4} wrap="wrap">
                        {overflowTags.map((t) => (
                          <Chip key={t.value} value={t.value} size="xs" variant="light">
                            {t.label} {t.count}
                          </Chip>
                        ))}
                      </Group>
                    </Popover.Dropdown>
                  </Popover>
                )}
              </Group>
            </Chip.Group>
          )}
          <ScrollArea style={{ flex: 1 }} type="hover">
            <Stack gap="xs" pr="xs">
              {ownList.map((r) => (
                <RecipeRow key={`own:${r.id}`} def={r} shared={false} />
              ))}
              {ownList.length === 0 && (
                <Text size="xs" c="dimmed" py="sm" ta="center">No recipes yet.</Text>
              )}
              {sharedList.length > 0 && (
                <>
                  <Text size="xs" fw={600} c="dimmed" tt="uppercase" mt="xs">Shared by others</Text>
                  {sharedList.map((r) => (
                    <RecipeRow key={`shared:${keyOf(r)}`} def={r} shared />
                  ))}
                </>
              )}
            </Stack>
          </ScrollArea>
          {picked.size > 0 && (
            <Paper withBorder radius="md" p={6}>
              <Group gap={6} wrap="nowrap" justify="space-between">
                <Text size="xs" c="dimmed">{picked.size} selected</Text>
                <Group gap={4} wrap="nowrap">
                  <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setPicked(new Set())}>
                    Clear
                  </Button>
                  <Button size="compact-xs" leftSection={<IconPlayerPlay size={11} />} onClick={() => setRunList(pickedDefs())}>
                    Run together
                  </Button>
                </Group>
              </Group>
            </Paper>
          )}
          <Button variant="default" leftSection={<IconPlus size={13} />} onClick={newRecipe}>
            New recipe
          </Button>
        </Stack>
      </Box>
      <Divider orientation="vertical" />

      {draft ? (
        <ScrollArea style={{ flex: 1 }} type="hover">
          <Stack gap="sm" p="md">
            {backTo && (
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                leftSection={<IconArrowLeft size={12} />}
                style={{ alignSelf: 'flex-start' }}
                onClick={goBack}
              >
                Back to {backTo.title}
              </Button>
            )}
            <Group justify="space-between" align="flex-end" wrap="nowrap" gap="md">
              <TextInput
                label="Recipe title"
                style={{ flex: 1 }}
                value={draft.title}
                disabled={readOnly}
                onChange={(e) => patch({ title: e.currentTarget.value })}
              />
              {draft.id && (
                <Badge variant="default" mb={6} style={{ whiteSpace: 'nowrap' }}>
                  v{draft.version ?? 1}
                </Badge>
              )}
              {draft.id && !readOnly && (
                <RestoreHistoryPopover
                  current={content(draft)}
                  currentVersion={draft.version}
                  versions={versionsFor(draft)}
                  onOpen={requestVersions}
                  onRestore={restore}
                />
              )}
              {readOnly ? (
                <Text size="xs" c="dimmed" pb={8} style={{ whiteSpace: 'nowrap' }}>
                  Shared by {draft.ownerName ?? 'another user'}
                </Text>
              ) : (
                <Switch
                  mb={7}
                  label="Published"
                  description="Share with everyone"
                  checked={draft.published ?? false}
                  onChange={(e) => patch({ published: e.currentTarget.checked })}
                />
              )}
            </Group>

            <Tooltip label="A saved recipe keeps its kind — switching would invalidate its history" disabled={!draft.id}>
              <SegmentedControl
                size="xs"
                w={200}
                value={kind}
                disabled={!!draft.id || readOnly}
                onChange={(v) => {
                  setKind(v as Kind);
                  // Drop the other kind's content so `content()` can't emit both.
                  patch(v === 'bundle' ? { members: [] } : { members: undefined });
                }}
                data={[
                  { value: 'prompt', label: 'Prompt' },
                  { value: 'bundle', label: 'Bundle' },
                ]}
              />
            </Tooltip>

            <Textarea
              label="Description"
              placeholder="One paragraph on what this does and when to reach for it."
              autosize
              minRows={2}
              maxRows={4}
              value={draft.description}
              disabled={readOnly}
              onChange={(e) => patch({ description: e.currentTarget.value })}
            />

            {readOnly ? (
              draft.tags.length > 0 && (
                <Box>
                  <div className={styles.label}>Tags</div>
                  <TagChips tags={draft.tags} bundle={isBundle(draft)} />
                </Box>
              )
            ) : (
              <TagsInput
                label="Tags"
                description="Optional. Pick from what others already use so the list stays browsable."
                placeholder={draft.tags.length >= RECIPE_TAG_MAX ? undefined : 'Add a tag'}
                maxTags={RECIPE_TAG_MAX}
                data={corpusTags}
                value={draft.tags}
                onChange={(v) => {
                  // Normalize on entry so the chip shows exactly what gets stored.
                  const normalized = v.map(normalizeRecipeTag).filter(Boolean);
                  patch({ tags: [...new Set(normalized)] });
                }}
              />
            )}

            {kind === 'bundle' ? (
              <Box>
                <div className={styles.label}>Recipes in this bundle</div>
                <Stack gap="xs">
                  <MemberList
                    members={draft.members ?? []}
                    resolve={resolve}
                    readOnly={readOnly}
                    onDragEnd={onMemberDragEnd}
                    onRemove={(i) => patch({ members: (draft.members ?? []).filter((_, j) => j !== i) })}
                    onJump={jumpTo}
                  />
                  {memberCount === 0 && (
                    <Text size="xs" c="dimmed">Add at least two recipes — they run in this order.</Text>
                  )}
                  {!readOnly && memberCount < RECIPE_BUNDLE_MAX && (
                    <Select
                      placeholder="Add recipe"
                      searchable
                      data={memberCandidates}
                      value={null}
                      onChange={(v) => {
                        if (!v) return;
                        const [ownerId, recipeId] = [v.slice(0, v.indexOf('/')), v.slice(v.indexOf('/') + 1)];
                        patch({ members: [...(draft.members ?? []), { ownerId, recipeId }] });
                      }}
                    />
                  )}
                  {unpublishedMembers > 0 && (draft.published ?? false) && (
                    <Alert variant="light" color="yellow" p="xs" icon={<IconAlertTriangle size={16} />}>
                      <Text size="xs">
                        {unpublishedMembers} member{unpublishedMembers === 1 ? '' : 's'} {unpublishedMembers === 1 ? 'is' : 'are'} unpublished — publish {unpublishedMembers === 1 ? 'it' : 'them'} first or this bundle can't be shared.
                      </Text>
                    </Alert>
                  )}
                </Stack>
              </Box>
            ) : (
              <Box>
                <div className={styles.label}>Prompt</div>
                <Textarea
                  autosize
                  minRows={8}
                  maxRows={24}
                  placeholder="The prompt the new session starts from."
                  classNames={{ input: styles.promptInput }}
                  value={draft.prompt}
                  disabled={readOnly}
                  onChange={(e) => patch({ prompt: e.currentTarget.value })}
                />
              </Box>
            )}

            <Box>
              <div className={styles.label}>Screenshots</div>
              <RecipeImages images={draft.images} readOnly={readOnly} onChange={(images) => patch({ images })} />
            </Box>

            {readOnly ? (
              <Group justify="flex-end">
                <Button
                  leftSection={<IconPlayerPlay size={13} />}
                  disabled={!openDef}
                  onClick={() => openDef && setRunList([openDef])}
                >
                  Run recipe
                </Button>
                <Button variant="default" leftSection={<IconCopy size={13} />} onClick={duplicate}>
                  Duplicate to my recipes
                </Button>
              </Group>
            ) : (
              <Group justify="space-between">
                {draft.id ? (
                  <Button variant="subtle" color="red" leftSection={<IconTrash size={13} />} onClick={() => setConfirmDelete(true)}>
                    Delete
                  </Button>
                ) : (
                  <span />
                )}
                <Group gap="xs">
                  {openDef && (
                    <Button
                      variant="default"
                      leftSection={<IconPlayerPlay size={13} />}
                      onClick={() => setRunList([openDef])}
                    >
                      Run
                    </Button>
                  )}
                  <Button variant="default" leftSection={<IconCopy size={13} />} onClick={duplicate}>
                    Duplicate
                  </Button>
                  <Button disabled={!valid || (!!draft.id && !dirty)} onClick={save}>
                    {draft.id ? (dirty ? 'Save changes' : 'Saved') : 'Save recipe'}
                  </Button>
                </Group>
              </Group>
            )}
          </Stack>
        </ScrollArea>
      ) : (
        <Stack align="center" justify="center" style={{ flex: 1 }} gap="xs">
          <Text size="sm" c="dimmed">Select a recipe or create a new one.</Text>
          <Button variant="light" leftSection={<IconPlus size={13} />} onClick={newRecipe}>
            New recipe
          </Button>
        </Stack>
      )}

      <ConfirmModal
        opened={confirmDelete}
        title="Delete recipe"
        message={`Remove "${draft?.title ?? ''}" from the library? Sessions it already started keep running.`}
        confirmLabel="Delete"
        confirmColor="red"
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      />

      <RecipeRunModal
        opened={!!runList}
        recipes={runList ?? []}
        onClose={() => setRunList(null)}
        onRan={onRan}
        onSaveAsBundle={saveSelectionAsBundle}
      />
    </Group>
  );
}
