import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { JOBS_ENQUEUER, JobsUnavailableError, type JobsEnqueuer, ManifestError, enqueueJob, parseInterval, validateManifest } from "../src/index.ts";

const base = {
  id: "reports",
  version: "1.0.0",
  name: "Reports",
  platform: "^0.1.0",
  dependsOn: {},
  schema: "reports",
  migrationsDir: "migrations",
  nav: [],
};

const withJobs = (jobs: unknown) => ({ ...base, jobs });
const problemsOf = (input: unknown): string[] => {
  try {
    validateManifest(input);
  } catch (error) {
    assert.ok(error instanceof ManifestError);
    return error.problems;
  }
  return [];
};

describe("parseInterval", () => {
  it("reads a number and a unit into milliseconds", () => {
    assert.equal(parseInterval("10s"), 10_000);
    assert.equal(parseInterval("5m"), 300_000);
    assert.equal(parseInterval("2h"), 7_200_000);
    assert.equal(parseInterval("1d"), 86_400_000);
    assert.equal(parseInterval("30d"), 2_592_000_000);
  });

  it("refuses anything else, below 10 seconds and above 30 days", () => {
    for (const text of ["", "5", "m", "5 m", " 5m", "5m ", "5M", "5w", "1.5h", "-5m", "+5m", "0s", "9s", "31d", "721h", "43201m", "1e3s", "05m", "5ms", "５m"]) {
      assert.equal(parseInterval(text), null, JSON.stringify(text));
    }
    assert.equal(parseInterval(10 as never), null);
    assert.equal(parseInterval(undefined as never), null);
  });
});

describe("validateManifest: jobs", () => {
  const job = (extra: Record<string, unknown> = {}) => ({ name: "sync", entry: "./jobs/sync.ts", ...extra });

  it("accepts a module with no jobs, a plain job and one with every option", () => {
    assert.deepEqual(problemsOf(base), []);
    assert.deepEqual(problemsOf(withJobs([job()])), []);
    assert.deepEqual(problemsOf(withJobs([job({ every: "5m", timeoutSeconds: 120, maxAttempts: 3 }), job({ name: "cleanup.old" })])), []);
  });

  it("requires an array of objects", () => {
    for (const jobs of ["sync", {}, [null], ["sync"], 1]) {
      assert.ok(problemsOf(withJobs(jobs)).some((p) => p.startsWith("jobs")), JSON.stringify(jobs));
    }
  });

  it("requires a stable name, unique in the module", () => {
    for (const name of ["", "Bad Name", "UPPER", "1sync", undefined, 5, "a b"]) {
      assert.ok(problemsOf(withJobs([job({ name })])).some((p) => p.includes("jobs[0].name")), String(name));
    }
    assert.ok(problemsOf(withJobs([job(), job({ entry: "./jobs/other.ts" })])).some((p) => p.includes("duplicated")));
  });

  it("requires a relative entry that cannot leave the module", () => {
    for (const entry of ["", "jobs/sync.ts", "/abs/sync.ts", "../x.ts", "./a/../../x.ts", "./a b.ts", undefined, 5]) {
      assert.ok(problemsOf(withJobs([job({ entry })])).some((p) => p.includes("jobs[0].entry")), String(entry));
    }
  });

  it("validates every, timeoutSeconds and maxAttempts", () => {
    for (const [patch, expected] of [
      [{ every: "9s" }, "every"],
      [{ every: "daily" }, "every"],
      [{ every: 60 }, "every"],
      [{ timeoutSeconds: 0 }, "timeoutSeconds"],
      [{ timeoutSeconds: 3601 }, "timeoutSeconds"],
      [{ timeoutSeconds: 1.5 }, "timeoutSeconds"],
      [{ timeoutSeconds: "60" }, "timeoutSeconds"],
      [{ maxAttempts: 0 }, "maxAttempts"],
      [{ maxAttempts: 21 }, "maxAttempts"],
      [{ maxAttempts: 2.5 }, "maxAttempts"],
    ] as Array<[Record<string, unknown>, string]>) {
      assert.ok(problemsOf(withJobs([job(patch)])).some((p) => p.includes(expected)), JSON.stringify(patch));
    }
    assert.deepEqual(problemsOf(withJobs([job({ timeoutSeconds: 3600, maxAttempts: 20, every: "10s" })])), []);
  });

  it("refuses unknown job fields", () => {
    assert.ok(problemsOf(withJobs([job({ cron: "* * * * *" })])).some((p) => p.includes("unknown field")));
  });

  it("keeps a module with pages, scopes and jobs together valid", () => {
    const manifest = {
      ...base,
      scopes: [{ key: "reports.read", label: "Read" }],
      pages: [{ path: "/reports", entry: "./web/page.tsx", kind: "page" }],
      jobs: [job()],
    };
    assert.deepEqual(problemsOf(manifest), []);
  });
});

describe("enqueueJob", () => {
  const holder = globalThis as typeof globalThis & { [JOBS_ENQUEUER]?: JobsEnqueuer };
  afterEach(() => {
    delete holder[JOBS_ENQUEUER];
  });

  it("says plainly when no platform registered an enqueuer", async () => {
    await assert.rejects(enqueueJob("reports", "sync"), (e: unknown) => e instanceof JobsUnavailableError && /no jobs enqueuer is registered/.test(e.message));
  });

  it("hands the module, the job, the payload and the options to the registered enqueuer", async () => {
    const seen: unknown[][] = [];
    holder[JOBS_ENQUEUER] = {
      enqueue: async (...args) => {
        seen.push(args);
        return { id: 7, deduplicated: false };
      },
    };
    const when = new Date("2026-10-20T12:00:00Z");
    assert.deepEqual(await enqueueJob("reports", "sync", { page: 2 }, { runAt: when, dedupeKey: "k" }), { id: 7, deduplicated: false });
    assert.deepEqual(await enqueueJob("reports", "sync"), { id: 7, deduplicated: false });
    assert.deepEqual(seen, [
      ["reports", "sync", { page: 2 }, { runAt: when, dedupeKey: "k" }],
      ["reports", "sync", null, {}],
    ]);
  });

  it("passes the enqueuer's own error through", async () => {
    holder[JOBS_ENQUEUER] = {
      enqueue: async () => {
        throw new Error("module is not enabled");
      },
    };
    await assert.rejects(enqueueJob("reports", "sync"), /module is not enabled/);
  });

  it("is the same enqueuer across SDK copies: it is found through a global symbol, not an import", () => {
    assert.equal(JOBS_ENQUEUER, Symbol.for("modunexo.jobs.enqueuer"));
  });
});
