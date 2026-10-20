// C259 backlog: ops/woodpecker-activate.ts --repo touches ONE repo only. Runs the real script against a fake Woodpecker and a
// fake `gh` (no network, no real token, a scratch HOME).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./woodpecker-activate.ts", import.meta.url));
const TOKEN = "wp-test-token-activate";
let server: Server;
let url = "";
const calls: { method: string; path: string }[] = [];
const repoIds = new Map<string, number>();
const IMAGE = "forge.polygonface.com/polygonface/tb-site-deploy:1.0.0";
/** What the fake Woodpecker lists for the website repo. */
let websiteRegistries: { address: string; username: string }[] = [{ address: "forge.polygonface.com", username: "forge-user" }];
let websiteSecrets: { name: string; events: string[]; images: string[] }[] = [];
const websiteId = () => repoIds.get("opt2-tealbrick-website");
let nextId = 100;

before(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      calls.push({ method: req.method ?? "", path });
      const json = (code: number, b: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(b));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, {});
      if (path === "/api/user") return json(200, { login: "tester" });
      const look = /^\/api\/repos\/lookup\/([^/]+)\/([^/]+)$/.exec(path);
      if (look) {
        const name = look[2] as string;
        if (look[1] !== "Tealbrick") return json(404, {});
        if (!repoIds.has(name)) repoIds.set(name, nextId++);
        return json(200, { id: repoIds.get(name), active: true, full_name: `Tealbrick/${name}` });
      }
      if (/^\/api\/repos\/\d+$/.test(path) && req.method === "PATCH") return json(200, {});
      const idOf = /^\/api\/repos\/(\d+)\//.exec(path)?.[1];
      const isWebsite = idOf !== undefined && Number(idOf) === websiteId();
      if (/^\/api\/repos\/\d+\/registries$/.test(path)) return json(200, isWebsite ? websiteRegistries : []);
      if (/^\/api\/repos\/\d+\/secrets$/.test(path)) return json(200, [{ name: "stray_secret", events: ["push"] }, ...(isWebsite ? websiteSecrets : [])]);
      if (/^\/api\/repos\/\d+\/secrets\/[^/]+$/.test(path)) return json(req.method === "DELETE" ? 204 : 404, {});
      if (path.startsWith("/api/orgs/lookup/")) return json(200, { id: 1 });
      if (path === "/api/orgs/1/secrets") return json(200, []);
      return json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => {
  websiteRegistries = [{ address: "forge.polygonface.com", username: "forge-user" }];
  websiteSecrets = [
    { name: "site_deploy_token", events: ["push", "tag"], images: [IMAGE] },
    { name: "site_deploy_key", events: ["push", "tag"], images: [IMAGE] },
  ];
  calls.length = 0;
  repoIds.clear();
  nextId = 100;
});

/** A scratch HOME with the token file and a fake `gh` that answers `gh api repos/<owner>/<repo>` for the Tealbrick owner. */
function sandbox(): { home: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), "tb-activate-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".config/opt2-tealbrick"), { recursive: true });
  writeFileSync(join(home, ".config/opt2-tealbrick/woodpecker-token"), `${TOKEN}\n`, { mode: 0o600 });
  const bin = join(root, "bin");
  mkdirSync(bin);
  // test fixture executable (generated at test time; plain node, no types)
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    [
      "#!/usr/bin/env node",
      "const m = /^repos\\/([^/]+)\\/(.+)$/.exec(process.argv[3] || '');",
      "if (!m || m[1] !== 'Tealbrick') process.exit(1);",
      "let h = 0; for (const c of m[2]) h = (h * 31 + c.charCodeAt(0)) % 100000;",
      "process.stdout.write('Tealbrick/' + m[2] + ' ' + (5000 + h) + '\\n');",
      "",
    ].join("\n"),
  );
  chmodSync(gh, 0o755);
  return { home, bin };
}

function run(args: string[]): Promise<{ code: number; out: string }> {
  const { home, bin } = sandbox();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, WOODPECKER_URL: url }, timeout: 60_000 },
      (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` }),
    );
  });
}

const touchedRepos = () => {
  const byId = new Map([...repoIds].map(([n, id]) => [id, n]));
  const names = new Set<string>();
  for (const c of calls) {
    const look = /^\/api\/repos\/lookup\/[^/]+\/([^/]+)$/.exec(c.path);
    if (look) names.add(look[1] as string);
    const id = /^\/api\/repos\/(\d+)(\/|$)/.exec(c.path);
    if (id) names.add(byId.get(Number(id[1])) ?? `unknown id ${id[1]}`);
  }
  return [...names].sort();
};

test("--repo fleet: only opt2-tealbrick-fleet is looked up, patched and has its secrets checked; no org-level secret call", async () => {
  const r = await run(["--repo", "fleet"]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(touchedRepos(), ["opt2-tealbrick-fleet"]);
  assert.ok(!calls.some((c) => c.path.startsWith("/api/orgs/")), "no org lookup or org secret call");
  const id = repoIds.get("opt2-tealbrick-fleet");
  assert.ok(
    calls.some((c) => c.method === "PATCH" && c.path === `/api/repos/${id}`),
    "settings patched",
  );
  assert.match(r.out, /opt2-tealbrick-fleet: settings ok \(visibility public\)/);
  assert.match(r.out, /--repo: only opt2-tealbrick-fleet/);
});

test("--repo accepts the full name and owner/name; a private-list repo keeps private visibility", async () => {
  for (const arg of ["opt2-tealbrick-creative", "Tealbrick/opt2-tealbrick-creative"]) {
    calls.length = 0;
    repoIds.clear();
    const r = await run(["--repo", arg]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(touchedRepos(), ["opt2-tealbrick-creative"]);
    assert.match(r.out, /opt2-tealbrick-creative: settings ok \(visibility private\)/);
  }
});

test("--repo with an unknown repo, no name, twice, or a stray argument fails before any Woodpecker call", async () => {
  for (const args of [["--repo", "nope"], ["--repo"], ["--repo", "fleet", "--repo", "sdk"], ["--repo", "fleet", "--yes"], ["fleet"]]) {
    calls.length = 0;
    const r = await run(args);
    assert.notEqual(r.code, 0, `${args.join(" ")} must fail`);
    assert.equal(calls.length, 0, `${args.join(" ")}: no Woodpecker call`);
  }
});

test("without --repo every listed repo is handled (the filter is opt-in)", async () => {
  const r = await run([]);
  assert.equal(r.code, 0, r.out);
  assert.ok(touchedRepos().length >= 20, `all repos touched: ${touchedRepos().length}`);
  assert.ok(
    calls.some((c) => c.path.startsWith("/api/orgs/")),
    "the full run still cleans org-level secrets",
  );
});

test("--repo website: the deploy secrets and the registry credential are kept (never deleted); a stray secret is still deleted", async () => {
  const r = await run(["--repo", "website"]);
  assert.equal(r.code, 0, r.out);
  const id = websiteId();
  assert.ok(id, "website repo handled");
  const deletes = calls.filter((c) => c.method === "DELETE").map((c) => c.path);
  assert.deepEqual(deletes, [`/api/repos/${id}/secrets/stray_secret`], "only the stray secret is deleted");
  assert.ok(!calls.some((c) => c.path.includes("/registries") && c.method !== "GET"), "registries are only read");
  assert.match(r.out, /opt2-tealbrick-website secret site_deploy_token: kept \(hand-made, C222\) \[push,tag\]\n/);
  assert.match(r.out, /opt2-tealbrick-website secret site_deploy_key: kept \(hand-made, C222\) \[push,tag\]\n/);
  assert.match(r.out, /opt2-tealbrick-website registry forge\.polygonface\.com: kept \(hand-made, C293a\) \[user forge-user\]/);
});

test("--repo website: a wrong image filter on a kept secret is a WARNING, still not deleted; a missing registry is reported, not created", async () => {
  websiteSecrets = [{ name: "site_deploy_key", events: ["push", "tag"], images: [] }];
  websiteRegistries = [];
  const r = await run(["--repo", "website"]);
  assert.equal(r.code, 0, r.out);
  assert.match(
    r.out,
    /site_deploy_key: kept .* WARNING: want events \[push,tag\] and the image filter \[forge\.polygonface\.com\/polygonface\/tb-site-deploy:1\.0\.0\]/,
  );
  assert.match(r.out, /site_deploy_token: MISSING/);
  assert.match(r.out, /registry forge\.polygonface\.com: MISSING/);
  assert.ok(!calls.some((c) => c.method === "DELETE" && /site_deploy|registries/.test(c.path)));
  assert.ok(!calls.some((c) => c.path.includes("/registries") && c.method !== "GET"));
});

test("--repo fleet: no registry call at all (the registry rule is for the website repo only)", async () => {
  const r = await run(["--repo", "fleet"]);
  assert.equal(r.code, 0, r.out);
  assert.ok(!calls.some((c) => c.path.includes("/registries")));
});
