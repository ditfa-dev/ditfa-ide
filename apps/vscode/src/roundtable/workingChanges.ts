import { execFile } from "node:child_process";
import { lstat, readFile, readlink, stat } from "node:fs/promises";
import { join } from "node:path";

/** What Panel Review reads: the working changes as one unified diff per file. */
export interface WorkingChanges {
  /** The repository root; findings' paths are relative to it. */
  root: string;
  /** "6 files, +120 −14, uncommitted changes" */
  scope: string;
  label: string;
  files: { path: string; patch: string }[];
}

/** Each reviewer reads every file, so the whole review must fit comfortably in one model call. */
const MAX_TOTAL_CHARS = 120_000;
const MAX_FILE_CHARS = 24_000;
const MAX_UNTRACKED_BYTES = 200_000;
const GIT_TIMEOUT_MS = 15_000;

/** Lock files, build output and minified bundles are noise for a reviewer and eat the budget. */
const SKIP = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock)$/,
  /(^|\/)(dist|build|out|node_modules|\.next|coverage)\//,
  /\.min\.(js|css)$/,
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|mp[34]|wav|lockb)$/i,
];

/**
 * Collects the uncommitted changes (staged, unstaged and new files) of the repository that holds `cwd`. Throws an
 * Error whose message is fit for the user when there is nothing to review.
 */
export async function collectWorkingChanges(cwd: string): Promise<WorkingChanges> {
  let root: string;
  try {
    root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    throw new Error("Panel Review reads your uncommitted changes, and this folder is not a Git repository.");
  }

  // Clean filters named in the repository's own config would run while the worktree is diffed: turn each one off.
  const filters = await git(root, ["config", "--get-regexp", "^filter\\..*\\.(clean|process|smudge)$"]).catch(() => "");
  const off = [
    ...new Set(
      filters
        .split("\n")
        .map((line) => line.split(" ")[0])
        .filter((key): key is string => Boolean(key)),
    ),
  ].flatMap((key) => ["-c", `${key}=`]);
  const diffArgs = (args: string[]) => [...off, ...args];

  const hasHead = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
    () => true,
    () => false,
  );
  // Against HEAD covers staged and unstaged edits together; a repository with no commit yet compares with nothing.
  const diff = hasHead
    ? await git(root, diffArgs(["diff", "HEAD", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=3", "--find-renames"]))
    : await git(root, diffArgs(["diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=3"]));
  const files = splitDiff(diff);

  const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean);
  for (const path of untracked) {
    if (files.some((file) => file.path === path)) continue;
    const patch = await newFilePatch(root, path);
    if (patch) files.push({ path, patch });
  }

  const reviewable = files.filter((file) => !SKIP.some((pattern) => pattern.test(file.path)));
  if (reviewable.length === 0) {
    throw new Error(
      files.length > 0
        ? "Only lock files, build output or binary files changed: there is no code for the panel to review."
        : "There are no uncommitted changes to review. Make a change, or review before you commit.",
    );
  }

  let added = 0;
  let removed = 0;
  for (const file of reviewable) {
    for (const line of file.patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
    }
  }

  // Smallest files first, so one huge file cannot crowd out every other change.
  const kept: { path: string; patch: string }[] = [];
  let total = 0;
  let cut = 0;
  for (const file of [...reviewable].sort((a, b) => a.patch.length - b.patch.length)) {
    const patch =
      file.patch.length > MAX_FILE_CHARS
        ? `${file.patch.slice(0, MAX_FILE_CHARS)}\n… (the rest of this file's diff was cut to fit the review)`
        : file.patch;
    if (total + patch.length > MAX_TOTAL_CHARS) {
      cut += 1;
      continue;
    }
    kept.push({ path: file.path, patch });
    total += patch.length;
  }
  kept.sort((a, b) => a.path.localeCompare(b.path));

  const count = `${kept.length} ${kept.length === 1 ? "file" : "files"}`;
  const scope = `${count}, +${added} −${removed}, uncommitted changes${cut > 0 ? ` (${cut} more too large to include)` : ""}`;
  return { root, scope, label: "uncommitted changes", files: kept };
}

/** The top of the Git repository holding `cwd`, or null outside one. Findings' paths are relative to it. */
export async function repositoryRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim() || null;
  } catch {
    return null;
  }
}

/** Splits `git diff` output into one patch per file, keyed by the file's new path. */
export function splitDiff(diff: string): { path: string; patch: string }[] {
  const files: { path: string; patch: string }[] = [];
  const chunks = diff.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith("diff --git "));
  for (const chunk of chunks) {
    if (/^Binary files /m.test(chunk) || /^GIT binary patch/m.test(chunk)) continue;
    // Git ends a name with a space in it with a tab, and quotes a name it cannot print as is.
    const next = /^\+\+\+ "?b\/(.+?)"?\t?$/m.exec(chunk)?.[1];
    const header = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/m.exec(chunk);
    const deleted = /^\+\+\+ \/dev\/null$/m.test(chunk);
    const path = deleted ? header?.[1] : (next ?? header?.[2]);
    if (!path) continue;
    // Only hunks matter to a reviewer; mode lines and index hashes are noise.
    const body = chunk.slice(Math.max(0, chunk.search(/^@@/m)));
    if (!body.startsWith("@@")) continue;
    files.push({ path: deleted ? `${path} (deleted)` : path, patch: body.trimEnd() });
  }
  return files;
}

async function newFilePatch(root: string, path: string): Promise<string | null> {
  try {
    const full = join(root, path);
    // A link is shown as git shows it, never followed: it could point at secrets outside the repository.
    const link = await lstat(full);
    if (link.isSymbolicLink()) return `@@ -0,0 +1 @@ (new symbolic link)\n+${await readlink(full)}`;
    const info = await stat(full);
    if (!info.isFile() || info.size > MAX_UNTRACKED_BYTES) return null;
    const text = await readFile(full, "utf8");
    if (text.includes("\0")) return null;
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return [`@@ -0,0 +1,${lines.length} @@ (new file)`, ...lines.map((line) => `+${line}`)].join("\n");
  } catch {
    return null;
  }
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      // A repository's own config can name programs git runs (fsmonitor, textconv, external diff): none may run.
      ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-c", "core.quotePath=false", ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}
