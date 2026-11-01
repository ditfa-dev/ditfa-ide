import type { McpTransport, SettingsSnapshot } from "@ditfa-ide/contract/settings";

/**
 * What every section builder reads. The builders are pure: they turn this into
 * markup, and `main.ts` owns everything that changes.
 */

export type SectionId =
  | "account"
  | "models"
  | "agent"
  | "completion"
  | "voice"
  | "roundtable"
  | "mcp"
  | "skills"
  | "about";

/** The add-server form keeps its text here, so a snapshot arriving mid-typing does not wipe it. */
export interface McpForm {
  name: string;
  transport: McpTransport;
  target: string;
}

export interface ViewContext {
  /** The saved snapshot with the user's pending edits on top. */
  snapshot: SettingsSnapshot;
  /** Setting keys and action keys the host is working on. */
  busy: ReadonlySet<string>;
  /** Text typed into a field and not committed yet, by field id. */
  drafts: ReadonlyMap<string, string>;
  /** Inline validation messages, by field id. */
  errors: ReadonlyMap<string, string>;
  mcpForm: McpForm;
  /** The MCP server whose Remove button is waiting for a second click. */
  confirmingRemoval: string | null;
  now: number;
}

export interface Row {
  id: string;
  html: string;
  /** Plain text the search matches against. */
  search: string;
  /** Renders on its own rather than inside the group's card. */
  block?: boolean;
  /** Repeats a control that lives in another section, so search skips it. */
  alias?: boolean;
}

export interface Group {
  title: string;
  note?: string;
  rows: Row[];
}
