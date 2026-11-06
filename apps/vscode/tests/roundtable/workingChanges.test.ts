import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { collectWorkingChanges, splitDiff } from "@ditfa-ide/vscode/roundtable/workingChanges";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 export { a, b };
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone
`;

describe("Panel Review's diff", () => {
  it("keeps one patch per file, hunks only, and skips binaries", () => {
    const files = splitDiff(DIFF);
    expect(files.map((file) => file.path)).toEqual(["src/a.ts", "old.ts (deleted)"]);
    expect(files[0]?.patch.startsWith("@@ -1,3 +1,3 @@")).toBe(true);
    expect(files[0]?.patch).not.toContain("index 1111111");
  });

  it("reads staged, unstaged and new files, and says when there is nothing to review", async () => {
    const root = mkdtempSync(join(tmpdir(), "panel-review-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: root });
    git("init", "-q");
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    git("add", ".");
    git("commit", "-qm", "start");
    await expect(collectWorkingChanges(root)).rejects.toThrow(/no uncommitted changes/);

    writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
    writeFileSync(join(root, "b.ts"), "export const b = 1;\n");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lock: 1\n");
    const changes = await collectWorkingChanges(root);
    expect(changes.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
    expect(changes.scope).toBe("2 files, +2 −1, uncommitted changes");
  });

  it("runs no program the repository configures, keeps odd names, and never follows a link", async () => {
    const root = mkdtempSync(join(tmpdir(), "panel-review-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: root });
    git("init", "-q");
    writeFileSync(join(root, "my file.ts"), "a\n");
    writeFileSync(join(root, "café.ts"), "a\n");
    git("add", ".");
    git("commit", "-qm", "start");
    const marker = join(root, "..", `pwned-${Date.now()}`);
    git("config", "filter.x.clean", `touch ${marker}; cat`);
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(join(root, ".git", "info", "attributes"), "*.ts filter=x\n");
    writeFileSync(join(root, "my file.ts"), "b\n");
    writeFileSync(join(root, "café.ts"), "b\n");
    symlinkSync("/etc/hosts", join(root, "hosts.ts"));
    const changes = await collectWorkingChanges(root);
    expect(existsSync(marker)).toBe(false);
    expect(changes.files.map((file) => file.path)).toEqual(["café.ts", "hosts.ts", "my file.ts"]);
    expect(changes.files.find((file) => file.path === "hosts.ts")?.patch).toBe("@@ -0,0 +1 @@ (new symbolic link)\n+/etc/hosts");
  });
});
