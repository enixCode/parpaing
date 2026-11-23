// Checks made before parpaing serves anything, kept apart from main.ts so they can be tested alone.
const LOCAL = ["127.0.0.1", "localhost", "::1", "[::1]"];

// The reason not to start, or undefined: published beyond this machine without a key, the API is open to anyone who reaches it.
export function exposureError(address: string | undefined, key: string | undefined) {
  if (!address || LOCAL.includes(address) || key) return undefined;
  return `parpaing: PARPAING_ADDRESS=${address} exposes the API beyond this machine: set PARPAING_API_KEY`;
}
