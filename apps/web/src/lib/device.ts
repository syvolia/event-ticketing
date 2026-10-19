// Stable per-install device id. Sent with every scan so the server can
// distinguish "same scan replay" from "another device saw the same ticket".
const KEY = 'ticketing.deviceId';

export function getDeviceId(): string {
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = `dev-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    localStorage.setItem(KEY, id);
  }
  return id;
}