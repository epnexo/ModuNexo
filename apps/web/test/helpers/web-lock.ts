import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCK = join(tmpdir(), "epnexo-web-build.lock");

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * The end-to-end tests each build and serve apps/web, which has one `.next` and one generated registry; test files
 * run in parallel processes, so they take turns. Returns the function that gives the turn up.
 */
export async function acquireWebLock(): Promise<() => void> {
  const deadline = Date.now() + 15 * 60 * 1000;
  for (;;) {
    try {
      mkdirSync(LOCK);
      writeFileSync(join(LOCK, "pid"), String(process.pid));
      return () => rmSync(LOCK, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let holder = 0;
    try {
      holder = Number(readFileSync(join(LOCK, "pid"), "utf8"));
    } catch {
      holder = 0;
    }
    if (holder > 0 && !alive(holder)) {
      // Moving it away is atomic: of several waiters that saw the same dead holder only one wins, and the others
      // cannot remove the fresh lock that winner is about to create.
      const stale = `${LOCK}.stale-${process.pid}-${Date.now()}`;
      try {
        renameSync(LOCK, stale);
        rmSync(stale, { recursive: true, force: true });
      } catch {
        // Somebody else took it first.
      }
    }
    else if (Date.now() > deadline) throw new Error(`the web build lock is held by pid ${holder}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
