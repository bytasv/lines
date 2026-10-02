import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  Menu,
  Popover,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowUp,
  IconCopy,
  IconDots,
  IconHistory,
  IconLibrary,
  IconLock,
  IconPencil,
  IconPin,
  IconTrash,
} from '@tabler/icons-react';
import type { ModelOption, StepContent, StepDef } from '@lines/shared';
import type { DraftStep, StepErrors } from './useWorkflowDraft';
import { permissionModeLabel } from '../../lib/permissionModes';
import { PromptEditor } from './PromptEditor';
import { crossesProvider, effortLabel, gateLabel, startLabel, StepSettings } from './StepSettings';
import { StepBanner, StepPane } from './StepPane';
import styles from './workflow.module.css';

const cn = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(' ');

const FIELD_LABELS: Record<keyof StepContent, string> = {
  name: 'Name',
  promptTemplate: 'Prompt',
  model: 'Model',
  reasoningEffort: 'Effort',
  permissionMode: 'Permission',
  autoAdvance: 'When it finishes',
  freshStart: 'How it starts',
  outputName: 'Output name',
  routing: 'Routing rule',
};

/** One field's value as diff text, in the words the editor shows it in; objects
 *  (the routing rule) as JSON, so an edit inside one is visible rather than two
 *  identical `[object Object]`s. */
function fieldText<K extends keyof StepContent>(k: K, v: StepContent[K]): string {
  if (k === 'autoAdvance') return gateLabel(v === true);
  if (k === 'freshStart') return startLabel(v === true);
  if (k === 'reasoningEffort') return effortLabel(v as StepContent['reasoningEffort']);
  if (k === 'permissionMode') return permissionModeLabel(String(v));
  if (v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function changedFields(a: StepContent, b: StepContent): (keyof StepContent)[] {
  return (Object.keys(FIELD_LABELS) as (keyof StepContent)[]).filter(
    (k) => fieldText(k, a[k]) !== fieldText(k, b[k]),
  );
}

/** Compact relative time ("3d ago"); falls back to empty when no timestamp. */
export function relTime(ms?: number): string {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const units: [number, string][] = [[86400, 'd'], [3600, 'h'], [60, 'm']];
  for (const [secs, label] of units) {
    if (s >= secs) return `${Math.floor(s / secs)}${label} ago`;
  }
  return 'just now';
}

/** Per-field diff of two step contents (red − / green +), or an empty-state note. */
export function FieldDiffList({ from, to }: { from: StepContent; to: StepContent }) {
  const fields = changedFields(from, to);
  if (fields.length === 0) return <Text size="xs" c="dimmed">No field changes.</Text>;
  return (
    <ScrollArea.Autosize mah={280} type="auto">
      <Stack gap={10}>
        {fields.map((f) => (
          <Stack key={f} gap={2}>
            <Text size="xs" fw={600} c="dimmed">{FIELD_LABELS[f]}</Text>
            <Text size="xs" c="red" style={{ whiteSpace: 'pre-wrap' }}>- {fieldText(f, from[f]) || '(empty)'}</Text>
            <Text size="xs" c="green" style={{ whiteSpace: 'pre-wrap' }}>+ {fieldText(f, to[f]) || '(empty)'}</Text>
          </Stack>
        ))}
      </Stack>
    </ScrollArea.Autosize>
  );
}

/** The diff a pinned step would take on updating, behind whatever `children` is. */
function UpdatePopover({
  pinned,
  head,
  onUpdate,
  children,
}: {
  pinned: StepContent;
  head: StepDef;
  onUpdate: () => void;
  children: ReactNode;
}) {
  return (
    <Popover width={360} position="bottom-end" withArrow shadow="md">
      <Popover.Target>{children}</Popover.Target>
      <Popover.Dropdown>
        <Stack gap={10}>
          <Text size="xs" fw={600}>
            {head.ownerName ?? 'The owner'} published v{head.version}
          </Text>
          <FieldDiffList from={pinned} to={head} />
          <Button size="xs" onClick={onUpdate}>Update to v{head.version}</Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

/**
 * Browse a step's version history and re-pin. Rows are newest-first and gap-tolerant. Selecting a
 * row previews a diff of the pinned content vs that version and offers "Pin to vN" (disabled for the
 * current pin). `versions === undefined` = still loading. `onOpen` triggers the fetch.
 */
function VersionHistoryPopover({
  step,
  versions,
  opened,
  onOpenChange,
  onPin,
  children,
}: {
  step: DraftStep;
  versions?: StepDef[];
  opened: boolean;
  onOpenChange: (open: boolean) => void;
  onPin: (def: StepDef) => void;
  children: ReactNode;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const pinnedVersion = step.ref?.version;
  const preview = versions?.find((v) => v.version === selected);

  return (
    <Popover
      width={360}
      position="bottom-end"
      withArrow
      shadow="md"
      opened={opened}
      onChange={(o) => {
        if (o) setSelected(null);
        onOpenChange(o);
      }}
    >
      <Popover.Target>
        <Box style={{ display: 'inline-flex' }}>{children}</Box>
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
                      className={cn(styles.versionRow, selected === v.version && styles.versionRowActive)}
                      onClick={() => setSelected(v.version)}
                    >
                      <Text size="sm" fw={600}>v{v.version}</Text>
                      <Text size="xs" c="dimmed" style={{ flex: 1, minWidth: 0 }} truncate>
                        {relTime(v.updatedAt)}{v.ownerName ? ` · ${v.ownerName}` : ''}
                      </Text>
                      {v.version === pinnedVersion && (
                        <Badge size="xs" variant="light" tt="none">pinned</Badge>
                      )}
                    </UnstyledButton>
                  ))}
                </Stack>
              </ScrollArea.Autosize>
              {preview && (
                <>
                  <FieldDiffList from={step} to={preview} />
                  <Button
                    size="xs"
                    disabled={preview.version === pinnedVersion}
                    onClick={() => {
                      onPin(preview);
                      onOpenChange(false);
                    }}
                  >
                    Pin to v{preview.version}
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

/**
 * The pane that edits the workflow step picked in the outline: what the step is
 * (pinned, someone else's, being edited, a copy), its prompt at full height, and
 * its settings. The gate and start mode are not here — they sit on the outline's
 * links, between the steps they connect.
 */
export function StepCard({
  step,
  index,
  total,
  previousModel,
  errors,
  readOnly,
  models,
  ownsRef,
  updateDef,
  editingFrom,
  unavailable = false,
  onPatch,
  onDuplicate,
  onRemove,
  onPublish,
  onEdit,
  onDetach,
  onMove,
  onUpdateToLatest,
  versions,
  onShowVersions,
  onPinVersion,
  availableOutputs,
}: {
  step: DraftStep;
  index: number;
  total: number;
  /** The model the step before this one runs on; undefined for step 0, whose
   *  predecessor is the session itself and is not known until the run. */
  previousModel?: string;
  /** Output names published by earlier steps — offered as {outputs.<name>} tokens. */
  availableOutputs: string[];
  errors?: StepErrors;
  readOnly: boolean;
  models: ModelOption[];
  ownsRef: boolean;
  updateDef?: StepDef;
  /** The library step an inline step was opened from for editing (`publishStepId`);
   *  saving it to the library mints the version after this one. */
  editingFrom?: StepDef;
  /** A ref whose pinned version is not known here, so there is no content to copy. */
  unavailable?: boolean;
  /** Fetched version history for this ref; undefined while loading. */
  versions?: StepDef[];
  onPatch: (patch: Partial<StepContent>) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onPublish: () => void;
  onEdit: () => void;
  onDetach: () => void;
  onMove: (delta: -1 | 1) => void;
  onUpdateToLatest: () => void;
  onShowVersions: () => void;
  onPinVersion: (def: StepDef) => void;
}) {
  const isRef = !!step.ref;
  const contentReadOnly = readOnly || isRef;
  // Changing provider between steps drops the conversation — nothing carries
  // context from a Claude session to a codex thread — so a crossing step is a
  // fresh start whether or not the user asked for one.
  const forcedFresh = crossesProvider(previousModel, step.model);
  const modelKnown = models.length === 0 || models.some((m) => m.id === step.model);
  const modelWarning = contentReadOnly
    ? `Model "${step.model}" is no longer available — update, re-pin, or make an editable copy of this step to pick a current model`
    : `Model "${step.model}" is no longer available — pick a current model`;
  const canBrowseHistory = isRef && !readOnly;
  const [historyOpen, setHistoryOpen] = useState(false);
  const openHistory = () => {
    onShowVersions();
    setHistoryOpen(true);
  };
  const nextLibraryVersion = (editingFrom?.version ?? 0) + 1;
  const label = step.name.trim() || 'Untitled step';

  const source = step.ref
    ? {
        icon: ownsRef ? <IconPin size={12} /> : <IconLock size={12} />,
        text: ownsRef ? `Pinned v${step.ref.version}` : `${step.ref.ownerName ?? 'Shared'} · v${step.ref.version}`,
      }
    : null;
  const sourceControl =
    source &&
    (canBrowseHistory ? (
      <VersionHistoryPopover
        step={step}
        versions={versions}
        opened={historyOpen}
        onOpenChange={(o) => (o ? openHistory() : setHistoryOpen(false))}
        onPin={onPinVersion}
      >
        <Tooltip label="Version history" withArrow>
          <UnstyledButton className={styles.link} onClick={openHistory} aria-label={`${source.text} — version history`}>
            {source.icon}
            {source.text}
            <IconHistory size={12} />
          </UnstyledButton>
        </Tooltip>
      </VersionHistoryPopover>
    ) : (
      <span className={styles.link} data-static>
        {source.icon}
        {source.text}
      </span>
    ));

  const updateButton = updateDef && (
    <UpdatePopover pinned={step} head={updateDef} onUpdate={onUpdateToLatest}>
      <Button size="compact-xs" variant="light" color="yellow">
        Update to v{updateDef.version}
      </Button>
    </UpdatePopover>
  );

  const banner = isRef ? (
    unavailable ? (
      <StepBanner icon={<IconAlertTriangle size={14} />}>
        <b>Pinned step unavailable.</b> Version {step.ref!.version} is not known on this machine, so it can
        neither be shown nor run.
      </StepBanner>
    ) : ownsRef ? (
      <StepBanner
        icon={<IconPin size={14} />}
        actions={
          !readOnly && (
            <>
              {updateButton}
              <Button size="compact-xs" variant="default" leftSection={<IconPencil size={12} />} onClick={onEdit}>
                Edit in library
              </Button>
              <Button size="compact-xs" variant="default" leftSection={<IconCopy size={12} />} onClick={onDetach}>
                Make an editable copy
              </Button>
            </>
          )
        }
      >
        <b>
          Pinned to {step.name} v{step.ref!.version}
        </b>{' '}
        from your library{updateDef ? ` — v${updateDef.version} is available` : ''}. Its prompt and settings are
        the library step's.
      </StepBanner>
    ) : (
      <StepBanner
        icon={<IconLock size={14} />}
        actions={
          !readOnly && (
            <>
              {updateButton}
              <Button size="compact-xs" variant="default" leftSection={<IconCopy size={12} />} onClick={onDetach}>
                Make an editable copy
              </Button>
            </>
          )
        }
      >
        <b>From {step.ref!.ownerName ?? 'another user'}</b>, read-only · pinned to v{step.ref!.version}
        {updateDef ? ` — v${updateDef.version} is available` : ''}.
      </StepBanner>
    )
  ) : step.publishStepId ? (
    <StepBanner
      icon={<IconPencil size={14} />}
      actions={
        !readOnly && (
          <Button size="compact-xs" variant="default" leftSection={<IconLibrary size={12} />} onClick={onPublish}>
            Save to library as v{nextLibraryVersion}
          </Button>
        )
      }
    >
      <b>Editing {editingFrom?.name ?? step.name}</b> from your library. Save it there to publish
      v{nextLibraryVersion}; until then these edits stay in this workflow only.
    </StepBanner>
  ) : step.copiedFrom ? (
    <StepBanner icon={<IconCopy size={14} />}>
      Editable copy of{' '}
      <b>
        {step.copiedFrom.name} v{step.copiedFrom.version}
      </b>
      . Changes stay in this workflow; the library step is untouched.
    </StepBanner>
  ) : undefined;

  const header = (
    <>
      <div className={styles.paneTitle}>
        <div className={styles.label}>
          Step {index + 1} of {total}
        </div>
        <TextInput
          variant="unstyled"
          placeholder="Untitled step"
          aria-label="Step name"
          classNames={{ input: styles.titleInput }}
          value={step.name}
          readOnly={contentReadOnly}
          error={errors?.name}
          onChange={(e) => onPatch({ name: e.currentTarget.value })}
        />
      </div>
      <Group gap={4} wrap="nowrap" pt={18}>
        {sourceControl}
        {!modelKnown && (
          <Tooltip label={modelWarning} multiline w={240} withArrow>
            <ActionIcon size="sm" variant="subtle" color="yellow" aria-label={modelWarning}>
              <IconAlertTriangle size={14} />
            </ActionIcon>
          </Tooltip>
        )}
        {!readOnly && (
          <Menu position="bottom-end" width={230} withinPortal>
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" aria-label={`Actions for ${label}`}>
                <IconDots size={16} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {isRef && ownsRef && (
                <Menu.Item leftSection={<IconPencil size={14} />} onClick={onEdit}>
                  Edit in library
                </Menu.Item>
              )}
              {canBrowseHistory && (
                <Menu.Item leftSection={<IconHistory size={14} />} onClick={openHistory}>
                  Version history
                </Menu.Item>
              )}
              {isRef && (
                <Menu.Item leftSection={<IconCopy size={14} />} disabled={unavailable} onClick={onDetach}>
                  Make an editable copy
                </Menu.Item>
              )}
              {!isRef && (
                <Menu.Item leftSection={<IconLibrary size={14} />} onClick={onPublish}>
                  {step.publishStepId ? `Save to library as v${nextLibraryVersion}` : 'Save to library'}
                </Menu.Item>
              )}
              {!isRef && (
                <Menu.Item leftSection={<IconCopy size={14} />} onClick={onDuplicate}>
                  Duplicate
                </Menu.Item>
              )}
              <Menu.Divider />
              <Menu.Item leftSection={<IconArrowUp size={14} />} disabled={index === 0} onClick={() => onMove(-1)}>
                Move up
              </Menu.Item>
              <Menu.Item
                leftSection={<IconArrowDown size={14} />}
                disabled={index === total - 1}
                onClick={() => onMove(1)}
              >
                Move down
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={onRemove}>
                Remove
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>
    </>
  );

  return (
    <StepPane
      header={header}
      banner={
        <>
          {banner}
          {errors?.ref && (
            <Text size="xs" c="red">
              {errors.ref}
            </Text>
          )}
        </>
      }
      prompt={
        <PromptEditor
          fill
          value={step.promptTemplate}
          readOnly={contentReadOnly}
          error={errors?.prompt}
          inputClassName={styles.promptInput}
          freshStart={step.freshStart || forcedFresh}
          availableOutputs={availableOutputs}
          onChange={(v) => onPatch({ promptTemplate: v })}
        />
      }
      settings={
        <StepSettings
          flow="none"
          value={step}
          readOnly={contentReadOnly}
          models={models}
          errors={errors}
          previousModel={previousModel}
          onPatch={onPatch}
        />
      }
    />
  );
}
