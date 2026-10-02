/**
 * Which machine this browser is talking to. Persisted so a reload lands on the
 * same one, and read by the device gate at startup.
 */
const DEVICE_STORAGE_KEY = 'lines.deviceId';

/**
 * The machine this browser was on before the current one, so the header switcher
 * can toggle back to it. Written only when the remembered id actually changes —
 * every switch path goes through `rememberDeviceId`, so this is the one place.
 */
const PREVIOUS_DEVICE_STORAGE_KEY = 'lines.previousDeviceId';

export function rememberedDeviceId(): string | null {
  return localStorage.getItem(DEVICE_STORAGE_KEY);
}

export function rememberDeviceId(id: string): void {
  const current = localStorage.getItem(DEVICE_STORAGE_KEY);
  if (current && current !== id) localStorage.setItem(PREVIOUS_DEVICE_STORAGE_KEY, current);
  localStorage.setItem(DEVICE_STORAGE_KEY, id);
}

export function forgetDeviceId(): void {
  localStorage.removeItem(DEVICE_STORAGE_KEY);
}

export function previousDeviceId(): string | null {
  return localStorage.getItem(PREVIOUS_DEVICE_STORAGE_KEY);
}
