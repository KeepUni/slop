export function createHelper(): number {
  return 42;
}

export const defaultConfig = { retries: 3, timeout: 5000 };

const internalCache = new Map<string, unknown>();
