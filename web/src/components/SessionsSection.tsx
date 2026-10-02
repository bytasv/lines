import { useId, useState } from 'react';
import { SegmentedControl, Select } from '@mantine/core';
import type { PermissionMode, ReasoningEffort } from '@lines/shared';
import { capabilitiesForModel, providerForModel, REASONING_EFFORTS } from '@lines/shared';
import { useStore } from '../store';
import {
  AUTO_EFFORT,
  describedOptionRenderer,
  describedOptionStyles,
  effortSelectData,
  modelSelectData,
  renderOptionWithDescription,
} from '../lib/modelSelect';
import { PERMISSION_MODE_SEGMENTS } from '../lib/permissionModes';
import { SettingsGroup, SettingsRow, SettingsSwitchRow } from './SettingsLayout';

const CONTROL_WIDTH = 240;

/** `onOpenUpdates` follows GuardAllowlistSection's `onOpenReview`: the pane that
 *  fixes a missing CLI is a sibling of this one, and only the parent can switch. */
export function SessionsSection({ onOpenUpdates }: { onOpenUpdates: () => void }) {
  const id = useId();
  // Controlled only so the warning icon can close it before the pane switches —
  // see the composer for why this is the prop and not an injected store.
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const models = useStore((s) => s.models);
  const openaiConnected = useStore((s) => s.openaiAuth?.loggedIn === true);
  const claudeCli = useStore((s) => s.claudeCli);
  const codexCli = useStore((s) => s.codexCli);
  const defaults = useStore((s) => s.newSessionDefaults);
  const setDefaults = useStore((s) => s.setNewSessionDefaults);
  const autoContinueInterrupted = useStore((s) => s.autoContinueInterrupted);
  const setAutoContinueInterrupted = useStore((s) => s.setAutoContinueInterrupted);
  const compressResponses = useStore((s) => s.compressResponses);
  const setCompressResponses = useStore((s) => s.setCompressResponses);
  const planReasoningEffort = useStore((s) => s.planReasoningEffort);
  const setPlanReasoningEffort = useStore((s) => s.setPlanReasoningEffort);
  const planModeRejectWrites = useStore((s) => s.planModeRejectWrites);
  const setPlanModeRejectWrites = useStore((s) => s.setPlanModeRejectWrites);

  return (
    <>
      <SettingsGroup title="New session defaults">
        <SettingsRow
          label="Model"
          htmlFor={`${id}-model`}
          controlWidth={CONTROL_WIDTH}
          control={
            <Select
              id={`${id}-model`}
              // Both providers. An OpenAI model with no account connected is shown
              // disabled rather than hidden: hiding it leaves no clue the option
              // exists, and the Account pane is where the Connect button lives.
              data={modelSelectData(models, defaults.model, {
                ...(openaiConnected
                  ? {}
                  : { unavailable: { openai: 'Connect an OpenAI account in Account above' } }),
                // A CLI this machine doesn't have warns rather than blocks, exactly as
                // the composer's picker does: it is the prerequisite the app cannot fix,
                // and the icon leads to the Updates pane that can.
                warn: {
                  ...(claudeCli && claudeCli.state !== 'ok'
                    ? { anthropic: `Claude Code CLI is ${claudeCli.state === 'missing' ? 'not installed' : 'out of date'}` }
                    : {}),
                  ...(codexCli && codexCli.state !== 'ok'
                    ? { openai: `Codex CLI is ${codexCli.state === 'missing' ? 'not installed' : 'out of date'}` }
                    : {}),
                },
              })}
              dropdownOpened={modelDropdownOpen}
              onDropdownOpen={() => setModelDropdownOpen(true)}
              onDropdownClose={() => setModelDropdownOpen(false)}
              renderOption={describedOptionRenderer(() => {
                setModelDropdownOpen(false);
                onOpenUpdates();
              })}
              styles={describedOptionStyles}
              value={defaults.model}
              onChange={(v) => v && setDefaults({ ...defaults, model: v })}
              allowDeselect={false}
            />
          }
        />
        <SettingsRow
          label="Reasoning effort"
          description="How hard a new session thinks. Auto leaves it to the model."
          htmlFor={`${id}-effort`}
          controlWidth={CONTROL_WIDTH}
          control={
            <Select
              id={`${id}-effort`}
              // The chosen default model's own engine decides the vocabulary. The two
              // agree today; the capability is still what is asked, so they may not.
              data={effortSelectData(
                capabilitiesForModel(defaults.model, providerForModel).reasoningEfforts,
                defaults.reasoningEffort,
              )}
              renderOption={renderOptionWithDescription}
              value={defaults.reasoningEffort ?? AUTO_EFFORT}
              onChange={(v) =>
                v &&
                setDefaults({
                  ...defaults,
                  reasoningEffort: v === AUTO_EFFORT ? undefined : (v as ReasoningEffort),
                })
              }
              allowDeselect={false}
            />
          }
        />
        <SettingsRow
          label="Permission mode"
          controlWidth={CONTROL_WIDTH}
          control={
            <SegmentedControl
              size="xs"
              fullWidth
              data={PERMISSION_MODE_SEGMENTS}
              value={defaults.permissionMode}
              onChange={(v) => setDefaults({ ...defaults, permissionMode: v as PermissionMode })}
            />
          }
        />
      </SettingsGroup>

      {/* Global, not a newSessionDefaults member — hence its own group. Plan mode
          gets its own effort for the same reason codex keeps
          `plan_mode_reasoning_effort` in config rather than per thread: planning
          is the one turn worth paying more for regardless of the session. */}
      <SettingsGroup title="Plan mode">
        <SettingsRow
          label="Reasoning effort"
          description="Overrides every session's own effort on plan-mode turns, from the next turn. A level the session's engine lacks is ignored."
          htmlFor={`${id}-plan-effort`}
          controlWidth={CONTROL_WIDTH}
          control={
            <Select
              id={`${id}-plan-effort`}
              data={effortSelectData(REASONING_EFFORTS, planReasoningEffort)}
              renderOption={renderOptionWithDescription}
              value={planReasoningEffort ?? AUTO_EFFORT}
              onChange={(v) =>
                v && setPlanReasoningEffort(v === AUTO_EFFORT ? null : (v as ReasoningEffort))
              }
              allowDeselect={false}
            />
          }
        />
        <SettingsSwitchRow
          label="Auto-reject writes in plan mode"
          description="Deny edits, non-read shell commands and other writes instead of asking. The agent keeps planning."
          checked={planModeRejectWrites}
          onChange={setPlanModeRejectWrites}
        />
      </SettingsGroup>

      {/* Global, not a newSessionDefaults member — hence its own group. */}
      <SettingsGroup title="Recovery">
        <SettingsSwitchRow
          label="Auto-continue interrupted turns"
          description="Resume a turn that died with the app instead of waiting for the Continue button"
          checked={autoContinueInterrupted}
          onChange={setAutoContinueInterrupted}
        />
      </SettingsGroup>

      {/* Global, not a newSessionDefaults member — hence its own group. */}
      <SettingsGroup title="Replies">
        <SettingsSwitchRow
          label="Compress"
          description="Claude replies tersely, using fewer output tokens. Code, commits and security warnings stay in plain prose. Takes effect on each session's next fresh turn."
          checked={compressResponses}
          onChange={setCompressResponses}
        />
      </SettingsGroup>
    </>
  );
}
