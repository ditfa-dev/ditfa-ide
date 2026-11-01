import type {
  QuotaUsage,
  SettingsAccount,
  SettingsLinks,
  SettingsPlan,
  SettingsUsage,
  UpgradeOffer,
} from "@ditfa-ide/contract/settings";
import { icons } from "@ditfa-ide/webview/icons";
import { escapeHtml } from "@ditfa-ide/webview/markdown";
import { markSvg } from "@ditfa-ide/webview/mark";
import { button, chip, data, row } from "./controls";
import { formatDate, meter, type Meter } from "./format";
import { settingsIcons } from "./icons";
import type { Group, Row, ViewContext } from "./view";

const esc = escapeHtml;

/** Raster images only: an SVG could carry markup, and the CSP blocks anything remote anyway. */
const AVATAR = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+=*$/;

export function avatarSource(url: string | null): string | null {
  return url !== null && AVATAR.test(url) ? url : null;
}

export function accountGroups(ctx: ViewContext): Group[] {
  const { account, usage, upgrade } = ctx.snapshot;
  if (!account.signedIn) {
    return [{ title: "", rows: [welcomeRow(ctx)] }];
  }
  const groups: Group[] = [{ title: "", rows: [profileRow(ctx)] }];
  if (usage) {
    groups.push({ title: "Usage", rows: [usageRow(usage, ctx.now)] });
  }
  if (upgrade) {
    groups.push({ title: "", rows: [upgradeRow(upgrade, usage)] });
  }
  groups.push({ title: "Billing and access", rows: LINK_ROWS.map((link) => linkRow(link)) });
  return groups;
}

function welcomeRow(ctx: ViewContext): Row {
  const { source } = ctx.snapshot.account;
  const note =
    source === "apiKey"
      ? "Right now Ditfa uses your own API key."
      : source === "local"
        ? "Right now Ditfa uses a model on this machine."
        : "";
  const html =
    `<div class="card welcome">` +
    `<div class="moving-lines" aria-hidden="true">${"<span></span>".repeat(7)}</div>` +
    `${markSvg("assemble", "welcome-mark")}` +
    `<h2 class="welcome-title">Welcome to Ditfa Code</h2>` +
    `<p class="welcome-text">Sign in to use the models included with your Ditfa plan, with credits, voice and Ditfa tools.` +
    ` Prefer your own setup? Bring an API key or run a model on this machine.</p>` +
    `<div class="welcome-actions">` +
    button("Sign in with Ditfa", data({ action: "signIn" }), {
      variant: "brand",
      large: true,
      focus: "welcome-sign-in",
      busy: ctx.busy.has("signIn"),
    }) +
    `<div class="welcome-alt">` +
    button("Use an API key", data({ action: "useApiKey" }), {
      icon: icons.key,
      focus: "welcome-api-key",
      busy: ctx.busy.has("useApiKey"),
    }) +
    button("Use a local model", data({ action: "useLocalModel" }), {
      icon: icons.cpu,
      focus: "welcome-local",
      busy: ctx.busy.has("useLocalModel"),
    }) +
    `</div></div>${note ? `<p class="welcome-note">${esc(note)}</p>` : ""}</div>`;
  return {
    id: "account-welcome",
    block: true,
    html,
    search: "account sign in log in welcome ditfa api key local model ollama lm studio",
  };
}

function profileRow(ctx: ViewContext): Row {
  const { account } = ctx.snapshot;
  const { plan } = account;
  const name = account.name ?? account.email ?? "Ditfa account";
  const email = account.name && account.email ? `<div class="profile-email" dir="auto">${esc(account.email)}</div>` : "";
  const renews = plan?.periodEnd ? `${plan.isPaid ? "Renews" : "Resets"} ${formatDate(plan.periodEnd, ctx.now)}` : "";
  const via =
    account.source === "apiKey" ? "Models run on your own API key" : account.source === "local" ? "Models run on this machine" : "";
  const meta = planBadge(plan) + [renews, via].filter(Boolean).map((part) => `<span>${esc(part)}</span>`).join("");
  const html =
    `<div class="card profile">${avatar(account)}` +
    `<div class="profile-text"><div class="profile-name" dir="auto">${esc(name)}</div>${email}` +
    `<div class="profile-meta">${meta}</div></div>` +
    `<div class="profile-actions">` +
    button("Manage subscription", data({ action: "openLink", link: "manage" }), {
      icon: settingsIcons.external,
      focus: "account-manage",
    }) +
    button("Sign out", data({ action: "signOut" }), {
      variant: "ghost",
      icon: settingsIcons.signOut,
      focus: "account-sign-out",
      busy: ctx.busy.has("signOut"),
    }) +
    `</div></div>`;
  return {
    id: "account-profile",
    block: true,
    html,
    search: `account profile ${name} ${account.email ?? ""} ${plan?.label ?? ""} plan subscription manage sign out log out`,
  };
}

function avatar(account: SettingsAccount): string {
  const source = avatarSource(account.avatarUrl);
  const initials = Array.from(account.initials.trim()).slice(0, 2).join("").toUpperCase();
  return (
    `<span class="avatar" aria-hidden="true">${initials ? `<span>${esc(initials)}</span>` : settingsIcons.account}` +
    `${source ? `<img src="${esc(source)}" alt="" data-avatar />` : ""}</span>`
  );
}

function planBadge(plan: SettingsPlan | null): string {
  return plan ? chip(`${plan.label} plan`, { tone: plan.isPaid ? "brand" : "muted" }) : "";
}

function usageRow(usage: SettingsUsage, now: number): Row {
  const credits = meter(usage.credits.used, usage.credits.limit);
  const resets = usage.credits.periodEnd ? `Resets ${formatDate(usage.credits.periodEnd, now)}` : "";
  const quotas = usage.quotas.map((quota, index) => quotaItem(quota, index)).join("");
  const html =
    `<div class="card usage">` +
    `<div class="usage-head"><div><div class="usage-title" id="usage-credits-label">Credits</div>` +
    `${resets ? `<div class="usage-sub">${esc(resets)}</div>` : ""}</div>` +
    `<div class="usage-figure">${esc(credits.value)}</div></div>` +
    `${meterBar("usage-credits", credits, usage.credits.used, usage.credits.limit)}` +
    `<div class="meter-detail tone-${credits.tone}">${esc(credits.detail)}</div>` +
    `${quotas ? `<div class="quota-grid">${quotas}</div>` : ""}</div>`;
  return {
    id: "account-usage",
    block: true,
    html,
    search: `usage credits quota limit remaining left ${usage.quotas.map((quota) => quota.label).join(" ")}`,
  };
}

function quotaItem(quota: QuotaUsage, index: number): string {
  const measured = meter(quota.used, quota.limit);
  const id = `quota-${index}`;
  return (
    `<div class="quota"><div class="quota-head"><span class="quota-label" id="${id}-label" dir="auto">${esc(quota.label)}</span>` +
    `<span class="quota-value">${esc(measured.value)}</span></div>` +
    `${meterBar(id, measured, quota.used, quota.limit)}` +
    `<div class="meter-detail tone-${measured.tone}">${esc(measured.detail)}</div></div>`
  );
}

/** A usage bar. An unlimited allowance has nothing to measure, so its text alone carries it. */
export function meterBar(id: string, measured: Meter, used: number, limit: number | null): string {
  if (limit === null) {
    return `<div class="meter unlimited" aria-hidden="true"></div>`;
  }
  const max = Math.max(0, Math.round(limit));
  const now = Math.min(Math.max(0, Math.round(used)), max);
  return (
    `<div class="meter tone-${measured.tone}" role="meter" aria-labelledby="${id}-label" aria-valuemin="0"` +
    ` aria-valuemax="${max}" aria-valuenow="${now}" aria-valuetext="${esc(`${measured.value}, ${measured.detail}`)}">` +
    `<div class="meter-fill" style="width:${measured.percent}%"></div></div>`
  );
}

function upgradeRow(offer: UpgradeOffer, usage: SettingsUsage | null): Row {
  const credits = usage ? meter(usage.credits.used, usage.credits.limit) : null;
  const title =
    credits?.tone === "over"
      ? "You're out of credits"
      : credits?.tone === "near"
        ? "You're running low on credits"
        : `Get more with ${offer.nextPlan}`;
  const lead =
    credits?.tone === "over" || credits?.tone === "near"
      ? `${offer.nextPlan} gives you more every month, so you can keep going.`
      : `Move up to ${offer.nextPlan} when you need more room.`;
  const perks = (offer.perks ?? []).map((perk) => `<li>${icons.check}<span>${esc(perk)}</span></li>`).join("");
  const html =
    `<div class="upgrade"><div class="upgrade-text">` +
    `<div class="upgrade-eyebrow">${icons.bolt}<span>${esc(offer.nextPlan)}</span></div>` +
    `<div class="upgrade-title">${esc(title)}</div><p class="upgrade-lead">${esc(lead)}</p>` +
    `${perks ? `<ul class="perks">${perks}</ul>` : ""}</div>` +
    button(offer.label, data({ action: "openLink", link: "upgrade" }), {
      variant: "brand",
      large: true,
      icon: settingsIcons.external,
      focus: "account-upgrade",
    }) +
    `</div>`;
  return {
    id: "account-upgrade",
    block: true,
    html,
    search: `upgrade plan pricing more credits ${offer.nextPlan} ${offer.label} ${(offer.perks ?? []).join(" ")}`,
  };
}

const LINK_ROWS: { link: keyof SettingsLinks; label: string; description: string; keywords: string }[] = [
  {
    link: "billing",
    label: "Billing and invoices",
    description: "Payment method, invoices and receipts.",
    keywords: "payment card invoice receipt tax",
  },
  {
    link: "apiKeys",
    label: "Ditfa API keys",
    description: "Keys for scripts, CI and other tools that call Ditfa.",
    keywords: "token secret automation",
  },
  {
    link: "connections",
    label: "Connected apps",
    description: "Services Ditfa tools can use for you, such as GitHub or Google Drive.",
    keywords: "integrations oauth connections",
  },
];

function linkRow(link: (typeof LINK_ROWS)[number]): Row {
  const id = `account-link-${link.link}`;
  const field = { id, label: link.label, description: link.description };
  return {
    id,
    html: row(
      field,
      button("Open", data({ action: "openLink", link: link.link }), {
        icon: settingsIcons.external,
        focus: `${id}-open`,
        label: `Open ${link.label}`,
      }),
    ),
    search: `${link.label} ${link.description} ${link.keywords}`,
  };
}
