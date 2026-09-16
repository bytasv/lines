import { Group, Text, ThemeIcon, Tooltip } from '@mantine/core';
import type { ComboboxItem, SelectProps } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { ModelOption, ModelProvider, ReasoningEffort } from '@lines/shared';
import { capabilitiesFor } from '@lines/shared';

/** Any Select item that renders a dimmed second line under its label. */
export interface DescribedItem extends ComboboxItem {
  description?: string;
  /**
   * What is wrong with this option, as a warning icon beside the label with the
   * text in a tooltip — attached to the *specific* models it applies to rather
   * than announced beside the control for all of them.
   */
  warning?: string;
  /** The warning has somewhere to lead (Settings → Updates), so its icon is a
   *  link rather than a label. Set for `warn` reasons, not for `unavailable`
   *  ones: an account to connect is not fixed in the Updates pane. */
  warningActionable?: boolean;
}

/** Widen the dropdown for narrow described Selects without widening the input. */
export const modelComboboxProps = { width: 240, position: 'bottom-start' as const };

export interface ModelSelectOptions {
  /**
   * Which providers this call site may offer. Absent = all of them.
   *
   * A filter rather than a per-component `models.filter(...)`, because this module
   * is the single entry point every model Select goes through — a second place
   * that decides what a picker may show is how the four call sites drift.
   */
  providers?: ModelProvider[];
  /**
   * Providers to render present but disabled, with the reason in the option's
   * warning tooltip. For "you could use this, once you connect an account" —
   * hiding it would leave no clue the model exists.
   */
  unavailable?: Partial<Record<ModelProvider, string>>;
  /**
   * Providers blocked by something the *machine* is missing rather than something
   * the app decides — a CLI that is not installed. Disabled exactly like
   * `unavailable`; what differs is that the warning icon is a link to Settings →
   * Updates, which is the pane that fixes it.
   */
  warn?: Partial<Record<ModelProvider, string>>;
}

/** A model's provider, with the same "absent means anthropic" default the type has. */
function providerOf(model: ModelOption): ModelProvider {
  return model.provider ?? 'anthropic';
}

export function modelSelectData(
  models: ModelOption[],
  ensureId?: string,
  opts: ModelSelectOptions = {},
): DescribedItem[] {
  const allowed = opts.providers;
  const data: DescribedItem[] = models
    .filter((m) => !allowed || allowed.includes(providerOf(m)))
    .map((m) => {
      const provider = providerOf(m);
      const blocked = opts.unavailable?.[provider];
      const machineBlocked = opts.warn?.[provider];
      // A rule the app decides outranks a machine prerequisite: it is the reason
      // the option cannot be taken even once the CLI is installed.
      const warning = blocked ?? machineBlocked;
      return {
        value: m.id,
        label: m.label,
        // The model's own description stays: what it *is* does not change because
        // this machine cannot run it. The reason rides `warning` instead.
        description: m.description,
        ...(warning ? { disabled: true, warning } : {}),
        ...(!blocked && machineBlocked ? { warningActionable: true } : {}),
      };
    });
  // The stored id, whatever it is: an unknown, filtered-out or retired model must
  // render as a disabled row rather than leave the Select blank.
  if (ensureId && !data.some((m) => m.value === ensureId)) {
    data.push({ value: ensureId, label: ensureId, description: 'No longer available', disabled: true });
  }
  return data;
}

/**
 * The "no choice made" row of an effort Select. A real option rather than an
 * empty value, because Mantine renders an unmatched value as a blank input — and
 * "unset" is the default every session starts in, so it has to read as a choice.
 */
export const AUTO_EFFORT = 'auto';

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/**
 * Effort options for one engine, weakest first, led by Auto.
 *
 * Takes the provider's own list (`ProviderCapabilities.reasoningEfforts`) rather
 * than a vendor's vocabulary spelt out at the call site — same reason
 * {@link modelSelectData} takes the model list: this module is the single entry
 * point every described Select goes through.
 */
export function effortSelectData(
  efforts: readonly ReasoningEffort[],
  ensureValue?: string,
): DescribedItem[] {
  const data: DescribedItem[] = [
    { value: AUTO_EFFORT, label: 'Auto', description: 'The model’s own default' },
    ...efforts.map((e) => ({ value: e, label: EFFORT_LABELS[e] })),
  ];
  // Same trick modelSelectData uses: a stored level this provider no longer
  // offers renders as a disabled row instead of blanking the Select.
  if (ensureValue && !data.some((e) => e.value === ensureValue)) {
    data.push({ value: ensureValue, label: ensureValue, description: 'Not available here', disabled: true });
  }
  return data;
}

/** What a workflow step may be set to: a step runs on Claude only (an OpenAI
 *  model on a step is a validation error), so codex's `minimal` is unreachable. */
export const STEP_EFFORTS = capabilitiesFor('anthropic').reasoningEfforts;

/**
 * The option renderer, optionally with somewhere for a warning to lead.
 *
 * `onWarningClick` is what turns the icon from a label into a link: the tooltip
 * says *what* is missing in a few words, and the click goes to Settings →
 * Updates, which is where the version, the install command and the fix already
 * live. Without a handler the icon is still a tooltip, so the call sites that
 * have nowhere to send anyone lose nothing.
 */
export function describedOptionRenderer(
  onWarningClick?: () => void,
): SelectProps['renderOption'] {
  return ({ option }) => {
    const item = option as DescribedItem;
    const actionable = Boolean(onWarningClick && item.warningActionable);
    return (
      <div>
        <Group gap={6} wrap="nowrap">
          {/* The dimming lives here rather than on the row (see
              `describedOptionStyles`): Mantine fades the whole option, and
              `opacity` cannot be undone by a child — so the warning icon would
              fade with it, on exactly the rows that need it to stand out. */}
          <Text size="sm" c={item.disabled ? 'dimmed' : undefined}>
            {item.label}
          </Text>
          {item.warning && (
            <Tooltip
              label={actionable ? `${item.warning} — open Updates` : item.warning}
              withArrow
              multiline
              w={240}
              position="right"
            >
              <ThemeIcon
                size={14}
                radius="xl"
                color="orange"
                variant="filled"
                // A disabled option is `cursor: not-allowed` and ignores clicks;
                // this one element opts back in, so the icon stays hoverable and
                // clickable on a row that is otherwise inert.
                style={{ pointerEvents: 'auto', cursor: actionable ? 'pointer' : 'help' }}
                onMouseDown={(event) => {
                  if (!actionable) return;
                  // mousedown, not click: Combobox commits an option on mousedown,
                  // so a click handler would run after the pick was already made.
                  event.preventDefault();
                  event.stopPropagation();
                  onWarningClick!();
                }}
              >
                <IconAlertTriangle size={10} />
              </ThemeIcon>
            </Tooltip>
          )}
        </Group>
        {item.description && (
          <Text size="xs" c="dimmed">
            {item.description}
          </Text>
        )}
      </div>
    );
  };
}

/**
 * Styles for any Select rendered with {@link describedOptionRenderer}.
 *
 * Mantine dims a disabled option with `opacity: 0.35` on the row itself. That is
 * the right default and the wrong one here: the whole point of the warning icon
 * is that it stands out on a row nobody can pick. So the row keeps full opacity
 * and the renderer dims the label instead — the option still reads as disabled,
 * and Mantine still refuses to select it.
 */
export const describedOptionStyles = { option: { opacity: 1 } } as const;

export const renderOptionWithDescription: SelectProps['renderOption'] = describedOptionRenderer();

export const renderModelOption = renderOptionWithDescription;
