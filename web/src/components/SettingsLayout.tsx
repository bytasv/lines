import { Children, useId, type ReactNode } from 'react';
import { Box, Card, Stack, Switch, Text } from '@mantine/core';

/**
 * The surfaces every Settings pane is built from: a titled group of rows on one
 * bordered card, and the row itself — label and help on the left, the control
 * on the right. The hairline between rows is `.lines-settings-group` in
 * index.css, drawn in the card's own border colour so it follows the scheme.
 */
export function SettingsGroup({
  title,
  footer,
  children,
}: {
  title?: ReactNode;
  /** Dimmed note under the card — where a caveat that must stay visible goes. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Stack gap={6}>
      {title && (
        <Text size="xs" fw={600} c="dimmed" tt="uppercase" px="md">
          {title}
        </Text>
      )}
      <Card withBorder radius="md" padding={0} className="lines-settings-group">
        {children}
      </Card>
      {footer && (
        <Text size="xs" c="dimmed" px="md">
          {footer}
        </Text>
      )}
    </Stack>
  );
}

/**
 * One row of a {@link SettingsGroup}.
 *
 * The control sits in a column on the right. Given a `controlWidth`, that column
 * has that width from `sm` up and its own full-width line below `sm`, so a phone
 * gets a usable Select without a phone branch here — and without touching font
 * sizes, which would undo the 16px input rule in index.css. Unsized controls (a
 * switch, a button) keep their own width and stay on the right.
 */
export function SettingsRow({
  label,
  description,
  control,
  controlWidth,
  leftSection,
  htmlFor,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  controlWidth?: number | string;
  leftSection?: ReactNode;
  /** The control's id. Renders the label as a real `<label>` and ids the description for `aria-describedby`. */
  htmlFor?: string;
  /** Full-width extras under the row: a progress bar, notes, a form. */
  children?: ReactNode;
}) {
  return (
    <Box px="md" py="sm">
      <Box
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 'var(--mantine-spacing-xs) var(--mantine-spacing-md)',
        }}
      >
        {leftSection}
        {/* `anywhere`, so an email, URL or command prefix wraps instead of
            widening the pane past a phone's width. */}
        <Box style={{ flex: '1 1 14rem', minWidth: 0, overflowWrap: 'anywhere' }}>
          {htmlFor ? (
            <Text component="label" htmlFor={htmlFor} size="sm" fw={500} display="block">
              {label}
            </Text>
          ) : (
            <Text component="div" size="sm" fw={500}>
              {label}
            </Text>
          )}
          {description && (
            <Text
              component="div"
              id={htmlFor ? `${htmlFor}-description` : undefined}
              size="xs"
              c="dimmed"
            >
              {description}
            </Text>
          )}
        </Box>
        {control && (
          <Box
            w={controlWidth === undefined ? undefined : { base: '100%', sm: controlWidth }}
            style={{ marginLeft: 'auto', minWidth: 0 }}
          >
            {control}
          </Box>
        )}
      </Box>
      {Children.toArray(children).length > 0 && (
        <Stack gap={6} mt="xs">
          {children}
        </Stack>
      )}
    </Box>
  );
}

/** A row whose control is a switch. The label is the switch's own, so clicking it toggles. */
export function SettingsSwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <SettingsRow
      htmlFor={id}
      label={label}
      description={description}
      control={
        <Switch
          id={id}
          size="sm"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.currentTarget.checked)}
          aria-describedby={description ? `${id}-description` : undefined}
        />
      }
    />
  );
}
