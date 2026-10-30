/** Icons the settings panel adds to the chat's set, drawn on the same 16px grid. */

const icon = (body: string) =>
  `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const settingsIcons = {
  account: icon('<circle cx="8" cy="5.5" r="2.6"/><path d="M2.8 13.5c.9-2.4 2.8-3.6 5.2-3.6s4.3 1.2 5.2 3.6"/>'),
  models: icon('<path d="M8 1.8 13.5 5v6L8 14.2 2.5 11V5z"/><path d="M2.5 5 8 8.2 13.5 5M8 8.2v6"/>'),
  agent: icon('<rect x="3" y="4.5" width="10" height="8" rx="2"/><path d="M8 2v2.5M6 8.2v.6M10 8.2v.6M1.5 8v2M14.5 8v2"/>'),
  completion: icon('<path d="M2 8h8.5M7.5 5l3 3-3 3M13.5 4v8"/>'),
  voice: icon('<rect x="6" y="1.8" width="4" height="7.7" rx="2"/><path d="M3.5 7.6a4.5 4.5 0 0 0 9 0M8 12.2v2"/>'),
  roundtable: icon('<circle cx="8" cy="8.6" r="2.7"/><circle cx="8" cy="2.9" r="1.1"/><circle cx="13" cy="11.3" r="1.1"/><circle cx="3" cy="11.3" r="1.1"/>'),
  plug: icon('<path d="M6 1.8v3M10 1.8v3M4.4 4.8h7.2v2.6a3.6 3.6 0 0 1-7.2 0zM8 11v3.2"/>'),
  book: icon('<path d="M3 12.8V3.5A1.5 1.5 0 0 1 4.5 2H13v9.3H4.5A1.5 1.5 0 0 0 3 12.8a1.5 1.5 0 0 0 1.5 1.5H13"/>'),
  info: icon('<circle cx="8" cy="8" r="6"/><path d="M8 7.3v3.7M8 5v.1"/>'),
  lock: icon('<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>'),
  external: icon('<path d="M9.5 2.5h4v4M13.5 2.5 8 8M11.5 9v3.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1H7"/>'),
  refresh: icon('<path d="M13.2 8.6a5.2 5.2 0 1 1-1.6-4.3L13 5.6"/><path d="M13 2.6v3h-3"/>'),
  spark: icon('<path d="M8 2.2c.4 2.6 1.4 3.6 4 4-2.6.4-3.6 1.4-4 4-.4-2.6-1.4-3.6-4-4 2.6-.4 3.6-1.4 4-4zM12.6 10.8c.2 1.1.6 1.5 1.6 1.7-1 .2-1.4.6-1.6 1.7-.2-1.1-.6-1.5-1.6-1.7 1-.2 1.4-.6 1.6-1.7z"/>'),
  signOut: icon('<path d="M6.5 13.5h-3A1.5 1.5 0 0 1 2 12V4a1.5 1.5 0 0 1 1.5-1.5h3M10.5 11l3-3-3-3M13.5 8H6"/>'),
  doctor: icon('<path d="M1.5 8.5h3l1.5-4 3 8 1.5-4h4"/>'),
};
