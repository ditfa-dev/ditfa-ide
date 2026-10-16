/**
 * What editor-independent code needs from a logger. The extension's output-channel logger implements it; tests
 * pass a silent one.
 */
export interface Logger {
  error(message: string, error?: unknown): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

export const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
};
