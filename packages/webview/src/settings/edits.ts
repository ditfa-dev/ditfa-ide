import {
  actionKey,
  withSetting,
  type SettingKey,
  type SettingValue,
  type SettingsSnapshot,
} from "@ditfa-ide/contract/settings";

/**
 * Values the panel shows before the host has confirmed them.
 *
 * An edit stays on top of every snapshot that arrives while it is in flight,
 * and leaves once the host reports its key settled. The host sends a fresh
 * snapshot before it settles a key, so dropping the edit then shows the saved
 * value, or the old one when the write failed: a rollback needs nothing extra.
 * An error toast for the key drops it at once.
 */
export class Pending<V> {
  private readonly items = new Map<string, { value: V; inflight: number }>();

  get size(): number {
    return this.items.size;
  }

  set(key: string, value: V): void {
    this.items.set(key, { value, inflight: (this.items.get(key)?.inflight ?? 0) + 1 });
  }

  get(key: string): V | undefined {
    return this.items.get(key)?.value;
  }

  /** One write of `key` finished. A later write of the same key keeps the edit up. */
  settle(key: string): void {
    const item = this.items.get(key);
    if (item && item.inflight > 1) {
      item.inflight -= 1;
    } else {
      this.items.delete(key);
    }
  }

  /** A write of `key` failed: show the saved value again right away. */
  rollback(key: string): void {
    this.items.delete(key);
  }

  entries(): [string, V][] {
    return [...this.items].map(([key, item]) => [key, item.value]);
  }
}

/** The snapshot as the user should see it: saved values with pending edits and server toggles on top. */
export function applyPending(
  snapshot: SettingsSnapshot,
  settings: Pending<SettingValue<SettingKey>>,
  toggles: Pending<boolean>,
): SettingsSnapshot {
  let result = snapshot;
  for (const [key, value] of settings.entries()) {
    result = withSetting(result, key as SettingKey, value);
  }
  if (toggles.size === 0) {
    return result;
  }
  const servers = result.mcp.servers.map((server) => {
    const enabled = toggles.get(actionKey({ type: "toggleMcpServer", name: server.name, enabled: true }));
    if (enabled === undefined || enabled === server.enabled) {
      return server;
    }
    return { ...server, enabled, status: enabled ? ("unknown" as const) : ("disabled" as const) };
  });
  return { ...result, mcp: { ...result.mcp, servers } };
}
