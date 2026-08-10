import { Box } from '@mantine/core';
import logoUrl from '../assets/logo-mark.png';

/**
 * The Lines mark, plated.
 *
 * The art is near-black on transparent and would vanish into the dark header, so
 * the plate supplies the white ground and the rounded corners the PNG no longer
 * bakes in. Shared by the app header and the pre-app gate screens: two copies of
 * this styling would drift, and the second one would be the one nobody notices
 * has gone grey.
 *
 * There is no sibling wordmark, so `alt` carries the accessible name.
 */
export function BrandMark({ height = 24 }: { height?: number }) {
  return (
    <Box
      style={{
        background: '#ffffff',
        borderRadius: 6,
        padding: 4,
        display: 'flex',
        boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
      }}
    >
      <img src={logoUrl} alt="Lines" height={height} style={{ display: 'block', width: 'auto' }} />
    </Box>
  );
}
