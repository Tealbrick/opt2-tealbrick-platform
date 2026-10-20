// C293: the deploy script, with a mocked fetch (no network, no real token). Fake clock: polling takes no real time.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CI_CONTEXT,
  DEV_URL,
  DeployError,
  type Deps,
  fastForward,
  GITHUB_HOST_KEY,
  gitEnv,
  LIVE_URL,
  parseInputs,
  pluginVersion,
  pollVersion,
  pushBranch,
  ROLLBACK_HINT,
  redact,
  releaseBody,
  run as runPlugin,
  SSH_REMOTE,
  smoke,
} from "./site-deploy.ts";

/** An empty workspace and a fixed PATH: no test depends on the folder it runs in or on the CI environment of the runner. */
const CWD = mkdtempSync(join(tmpdir(), "tb-plugin-cwd-"));
const TEST_PATH = "/usr/bin:/bin";
const TOKEN = "github_pat_TESTONLY0123456789abcdefghijklmnop";
// A fake key (not a real key): the BEGIN/END lines and a body line that must never appear in any output.
const KEY_BODY = "FAKEKEYBODYLINE0123456789abcdefghijklmnopqrstuvwxyzFAKE";
const KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${KEY_BODY}\n-----END OPENSSH PRIVATE KEY-----`;
const A = "a".repeat(40); // old main commit
const B = "b".repeat(40); // newer main commit
const C = "c".repeat(40); // commit apart from main
const T = { timeout: 10_000 };

interface World {
  main: string;
  /** commit order on main, oldest first */
  mainLine: string[];
  heads: Record<string, string>;
  tags: Record<string, { type: "commit" | "tag"; sha: string; inner?: string }>;
  /** what DEV / LIVE answer for /version.txt, by call number (last one repeats) */
  devVersion: string[];
  liveVersion: string[];
  securityTxt: string;
  releases: { id: number; tag: string; body: string }[];
  calls: { method: string; url: string; body?: string; auth?: string | null }[];
  /** a TAG named "main" pointing at this commit: the compare API would resolve the bare name "main" to it (S3-a) */
  mainTag?: string;
  /** Woodpecker statuses per commit (default: push/ci success on every commit); the mock answers GET /commits/<sha>/status */
  statuses: Record<string, { context: string; state: string }[] | (() => { context: string; state: string }[])>;
  /** what the git push does: 'ok' moves the branch, 'reject' fails like a non-fast-forward, 'leak' fails and echoes the key */
  push: "ok" | "reject" | "leak";
  gitInits: { args: string[]; env: Record<string, string> }[];
  gitCalls: { args: string[]; env: Record<string, string>; keyFile: string; keyMode: number; keyText: string; hostsText: string }[];
}

function world(over: Partial<World> = {}): World {
  return {
    main: B,
    mainLine: [A, B],
    heads: { "site-dev": A, "site-live": A },
    tags: { "site-v1.0.0": { type: "commit", sha: B } },
    devVersion: [B],
    liveVersion: [B],
    securityTxt: "Contact: mailto:security@example.test\nExpires: 2027-01-01T00:00:00Z\n",
    releases: [],
    calls: [],
    push: "ok",
    gitInits: [],
    gitCalls: [],
    statuses: {},
    ...over,
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function relation(w: World, base: string, head: string): string {
  const resolve = (x: string) => (x === "main" ? (w.mainTag ?? w.main) : x);
  const b = resolve(base);
  const h = resolve(head);
  if (b === h) return "identical";
  const ib = w.mainLine.indexOf(b);
  const ih = w.mainLine.indexOf(h);
  if (ib >= 0 && ih >= 0) return ih > ib ? "ahead" : "behind";
  return "diverged";
}

/** A world where DEV already has B (the tip of site-dev), as LIVE requires. */
const liveWorld = (over: Partial<World> = {}): World => world({ heads: { "site-dev": B, "site-live": A }, ...over });

function fakeFetch(w: World): typeof fetch {
  const counts = { dev: 0, live: 0 };
  return (async (input: Request | string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    w.calls.push({ method, url, ...(init?.body ? { body: String(init.body) } : {}), auth: headers.authorization ?? null });
    const u = new URL(url);
    if (u.hostname === "api.github.com") {
      const p = u.pathname.replace("/repos/Tealbrick/opt2-tealbrick-website", "");
      const found: { m: RegExpExecArray | null } = { m: null };
      const hit = (re: RegExp): boolean => {
        found.m = re.exec(p);
        return found.m !== null;
      };
      if (hit(/^\/commits\/([0-9a-f]{40})\/status$/)) {
        const st = w.statuses[found.m?.[1] as string];
        const list = typeof st === "function" ? st() : (st ?? [{ context: "ci/woodpecker/push/ci", state: "success" }]);
        return json(200, { statuses: list });
      }
      if (p === "/git/ref/heads/main") return json(200, { object: { type: "commit", sha: w.main } });
      if (hit(/^\/git\/ref\/heads\/(.+)$/)) {
        const sha = w.heads[found.m?.[1] as string];
        return sha ? json(200, { object: { type: "commit", sha } }) : json(404, { message: "Not Found" });
      }
      if (hit(/^\/git\/ref\/tags\/(.+)$/)) {
        const t = w.tags[decodeURIComponent(found.m?.[1] as string)];
        return t ? json(200, { object: { type: t.type, sha: t.sha } }) : json(404, { message: "Not Found" });
      }
      if (hit(/^\/git\/tags\/([0-9a-f]+)$/)) {
        const t = Object.values(w.tags).find((x) => x.type === "tag" && x.sha === found.m?.[1]);
        return t ? json(200, { object: { type: "commit", sha: t.inner } }) : json(404, { message: "Not Found" });
      }
      if (hit(/^\/compare\/([^.]+)\.\.\.(.+)$/))
        return json(200, { status: relation(w, decodeURIComponent(found.m?.[1] as string), decodeURIComponent(found.m?.[2] as string)) });
      if (hit(/^\/releases\/tags\/(.+)$/)) {
        const r = w.releases.find((x) => x.tag === decodeURIComponent(found.m?.[1] as string));
        return r ? json(200, { id: r.id }) : json(404, { message: "Not Found" });
      }
      if (method === "POST" && p === "/releases") {
        const body = JSON.parse(String(init?.body)) as { tag_name: string; body: string };
        w.releases.push({ id: w.releases.length + 1, tag: body.tag_name, body: body.body });
        return json(201, { id: w.releases.length });
      }
      if (method === "PATCH" && hit(/^\/releases\/(\d+)$/)) {
        const r = w.releases.find((x) => x.id === Number(found.m?.[1]));
        if (r) r.body = (JSON.parse(String(init?.body)) as { body: string }).body;
        return json(200, { id: Number(found.m?.[1]) });
      }
      return json(500, { message: `unmocked ${method} ${p}` });
    }
    const dev = u.origin === DEV_URL;
    const live = u.origin === LIVE_URL;
    if (!dev && !live) return new Response("unmocked host", { status: 500 });
    if (u.pathname === "/version.txt") {
      const list = dev ? w.devVersion : w.liveVersion;
      const i = dev ? counts.dev++ : counts.live++;
      return new Response(`${list[Math.min(i, list.length - 1)]}\n`, { status: 200 });
    }
    if (u.pathname === "/.well-known/security.txt") return new Response(w.securityTxt, { status: 200 });
    if (u.pathname === "/" || u.pathname === "/robots.txt") return new Response("ok", { status: 200 });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
}

function setup(w: World) {
  let clock = Date.parse("2026-10-20T10:00:00Z");
  const lines: string[] = [];
  const deps: Deps = {
    cwd: CWD,
    path: TEST_PATH,
    fetch: fakeFetch(w),
    git: (args, env) => {
      if (args[0] === "init") {
        w.gitInits.push({ args, env });
        return { status: 0, stderr: "" };
      }
      const keyFile = /-i (\S+)/.exec(env.GIT_SSH_COMMAND ?? "")?.[1] ?? "";
      const hosts = /UserKnownHostsFile=(\S+)/.exec(env.GIT_SSH_COMMAND ?? "")?.[1] ?? "";
      w.gitCalls.push({
        args,
        env,
        keyFile,
        keyMode: existsSync(keyFile) ? statSync(keyFile).mode & 0o777 : -1,
        keyText: existsSync(keyFile) ? readFileSync(keyFile, "utf8") : "",
        hostsText: existsSync(hosts) ? readFileSync(hosts, "utf8") : "",
      });
      const m = /^([0-9a-f]{40}):refs\/heads\/(site-dev|site-live)$/.exec(args[5] ?? "");
      if (args[2] !== "push" || !m) return { status: 2, stderr: "unexpected git call" };
      if (w.push === "reject") return { status: 1, stderr: " ! [rejected] (non-fast-forward)" };
      if (w.push === "leak") return { status: 1, stderr: `error: bad key ${KEY_BODY} ${KEY} token ${TOKEN}` };
      w.heads[m[2] as string] = m[1] as string;
      return { status: 0, stderr: "" };
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    log: (l) => lines.push(l),
  };
  return { deps, lines, tick: () => clock };
}
const env = { PLUGIN_TOKEN: TOKEN, PLUGIN_DEPLOY_KEY: KEY };

/** The old command-line shape ('dev', sha) / ('live', tag, sha) as the plugin sees it: PLUGIN_MODE plus the pipeline's CI_COMMIT_* values. */
function run(argv: string[], e: Record<string, string | undefined>, deps: Deps): Promise<number> {
  const [mode, a, b] = argv;
  const ci = mode === "live" ? { CI_COMMIT_TAG: a, CI_COMMIT_SHA: b } : { CI_COMMIT_SHA: a };
  return runPlugin({ PLUGIN_MODE: mode, ...ci, ...e }, deps);
}

test("parseInputs: mode dev or live only; the commit and tag are only candidates read from CI_*", T, () => {
  assert.deepEqual(parseInputs({ PLUGIN_MODE: "dev", CI_COMMIT_SHA: A }), { mode: "dev", sha: A });
  assert.deepEqual(parseInputs({ PLUGIN_MODE: "live", CI_COMMIT_SHA: B, CI_COMMIT_TAG: "site-v1.0.0" }), { mode: "live", tag: "site-v1.0.0", sha: B });
  for (const mode of [undefined, "", "deploy", "DEV", "dev;live"]) assert.throws(() => parseInputs({ PLUGIN_MODE: mode }), DeployError);
});

test("the plugin reads VERSION (1.0.0) and logs it", T, async () => {
  assert.match(pluginVersion(), /^\d+\.\d+\.\d+$/);
  const { deps, lines } = setup(world());
  await run(["dev", B], env, deps);
  assert.equal(lines[0], `tb-site-deploy ${pluginVersion()}`);
});

test("a missing mode exits 2 and touches nothing", T, async () => {
  const w = world();
  const { deps } = setup(w);
  assert.equal(await runPlugin({ ...env, CI_COMMIT_SHA: B }, deps), 2);
  assert.equal(w.calls.length, 0);
});

test("redact: the token and token-shaped words never survive", T, () => {
  const out = redact(`failed with ${TOKEN} and ghp_abcdefghijklmnopqrstuvwxyz0123456789 and Authorization: Bearer ${TOKEN}`, TOKEN);
  assert.ok(!out.includes("TESTONLY"));
  assert.ok(!out.includes("ghp_abc"));
  assert.ok(!/Bearer\s+github/i.test(out));
});

test("dev: fast-forwards site-dev with force:false, sees the commit, passes the smoke", T, async () => {
  const w = world({ devVersion: [A, A, B] });
  const { deps, lines } = setup(w);
  assert.equal(await run(["dev", B], env, deps), 0);
  assert.equal(w.heads["site-dev"], B);
  assert.equal(w.gitCalls.length, 1);
  assert.deepEqual(w.gitCalls[0]?.args, ["-c", "core.hooksPath=/dev/null", "push", "--no-verify", SSH_REMOTE, `${B}:refs/heads/site-dev`]);
  assert.ok(!w.calls.some((c) => c.method === "PATCH"), "the API never moves a branch");
  assert.equal(w.heads["site-live"], A, "dev never touches site-live");
  assert.ok(lines.some((l) => l.includes("DEV smoke /.well-known/security.txt: ok")));
  assert.ok(
    w.calls.every((c) => !c.url.startsWith(LIVE_URL)),
    "dev never calls the live host",
  );
  assert.equal(w.releases.length, 0);
});

test("dev: the token is sent to GitHub only and appears in no output", T, async () => {
  const w = world();
  const { deps, lines } = setup(w);
  await run(["dev", B], env, deps);
  for (const c of w.calls) {
    if (new URL(c.url).hostname === "api.github.com") assert.equal(c.auth, `Bearer ${TOKEN}`);
    else assert.equal(c.auth, null, `no Authorization header to ${c.url}`);
  }
  assert.ok(!lines.join("\n").includes(TOKEN));
});

test("dev: a commit that is not on main is refused before anything moves", T, async () => {
  const w = world();
  const { deps, lines } = setup(w);
  assert.equal(await run(["dev", C], env, deps), 1);
  assert.equal(w.heads["site-dev"], A);
  assert.ok(w.calls.every((c) => c.method === "GET"));
  assert.ok(lines.some((l) => l.includes("not on main")));
});

test("dev: a commit older than site-dev is refused (not a fast-forward)", T, async () => {
  const w = world({ heads: { "site-dev": B, "site-live": A } });
  const { deps, lines } = setup(w);
  assert.equal(await run(["dev", A], env, deps), 1);
  assert.equal(w.heads["site-dev"], B);
  assert.ok(lines.some((l) => l.includes("cannot fast-forward") && l.includes("older")));
  assert.ok(w.calls.every((c) => c.method === "GET"));
  assert.equal(w.gitCalls.length, 0);
});

test("dev: a malformed SHA and a missing token are refused", T, async () => {
  const { deps, lines } = setup(world());
  assert.equal(await run(["dev", "main"], env, deps), 1);
  assert.equal(await run(["dev", B], {}, deps), 1);
  assert.ok(lines.some((l) => l.includes('the setting "token" is empty')));
});

test("dev: a missing branch names the one-time step", T, async () => {
  const w = world({ heads: {} });
  const { deps, lines } = setup(w);
  assert.equal(await run(["dev", B], env, deps), 1);
  assert.ok(lines.some((l) => l.includes("branch site-dev does not exist")));
});

test("dev: DEV never shows the commit -> fails after 15 minutes, with the rollback hint", T, async () => {
  const w = world({ devVersion: [A] });
  const { deps, lines, tick } = setup(w);
  const start = tick();
  assert.equal(await run(["dev", B], env, deps), 1);
  const waited = tick() - start;
  assert.ok(waited <= 15 * 60 * 1000 && waited >= 14 * 60 * 1000, `waited ${waited} ms`);
  assert.ok(lines.some((l) => l.includes("did not show") && l.includes("within 15 min")));
  assert.ok(lines.includes(ROLLBACK_HINT));
});

test("dev: a failed smoke fails the run", T, async () => {
  const { deps, lines } = setup(world({ securityTxt: "Expires: 2027-01-01T00:00:00Z\n" }));
  assert.equal(await run(["dev", B], env, deps), 1);
  assert.ok(lines.some((l) => l.includes("no Contact: line")));
});

test("live: refuses anything but site-vX.Y.Z before any call", T, async () => {
  for (const tag of ["v1.0.0", "site-v1.0", "site-v1.0.0-rc1", "site-v1.0.0/x", "site-dev", "main", "site-v01.0.0x"]) {
    const w = liveWorld();
    const { deps } = setup(w);
    assert.equal(await run(["live", tag, B], env, deps), 1, tag);
    assert.equal(w.calls.length, 0, `${tag}: no call was made`);
  }
});

test("live: tag on main -> site-live moves, LIVE is polled and smoked, the release records it", T, async () => {
  const w = liveWorld({ liveVersion: [A, B] });
  const { deps, lines } = setup(w);
  assert.equal(await run(["live", "site-v1.0.0", B], env, deps), 0);
  assert.equal(w.heads["site-live"], B);
  assert.equal(w.heads["site-dev"], B, "live never touches site-dev");
  assert.deepEqual(
    w.gitCalls.map((g) => g.args),
    [["-c", "core.hooksPath=/dev/null", "push", "--no-verify", SSH_REMOTE, `${B}:refs/heads/site-live`]],
  );
  assert.equal(w.releases.length, 1);
  const body = w.releases[0]?.body ?? "";
  assert.ok(body.includes(`Commit: ${B}`));
  assert.ok(body.includes(`/version.txt answered: ${B}`));
  assert.match(body, /Started \(UTC\): 2026-10-20T10:00:00Z/);
  assert.match(body, /\/\.well-known\/security\.txt: ok/);
  assert.match(body, /Rollback: merge a revert commit on main/);
  assert.ok(!body.includes(TOKEN) && !lines.join("\n").includes(TOKEN));
  const posted = w.calls.find((c) => c.method === "POST");
  assert.equal(JSON.parse(posted?.body ?? "{}").tag_name, "site-v1.0.0");
});

test("live: an annotated tag is followed to its commit", T, async () => {
  const w = liveWorld({ tags: { "site-v1.0.0": { type: "tag", sha: "d".repeat(40), inner: B } } });
  const { deps } = setup(w);
  assert.equal(await run(["live", "site-v1.0.0", B], env, deps), 0);
  assert.equal(w.heads["site-live"], B);
});

test("live: a tag whose commit is not on main is refused; nothing moves, no release", T, async () => {
  const w = liveWorld({ tags: { "site-v1.0.0": { type: "commit", sha: C } } });
  const { deps, lines } = setup(w);
  assert.equal(await run(["live", "site-v1.0.0", C], env, deps), 1);
  assert.equal(w.gitCalls.length, 0);
  assert.equal(w.heads["site-live"], A);
  assert.equal(w.releases.length, 0);
  assert.ok(w.calls.every((c) => c.method === "GET"));
  assert.ok(lines.some((l) => l.includes("is not on main")));
});

test("live: a tag that does not exist is refused", T, async () => {
  const w = liveWorld({ tags: {} });
  const { deps, lines } = setup(w);
  assert.equal(await run(["live", "site-v9.9.9", B], env, deps), 1);
  assert.ok(lines.some((l) => l.includes("does not exist on GitHub")));
});

test("live: an old tag (site-live is already ahead) is refused: rollback is a revert + a new tag", T, async () => {
  const w = liveWorld({ heads: { "site-dev": B, "site-live": B }, tags: { "site-v0.9.0": { type: "commit", sha: A } } });
  const { deps, lines } = setup(w);
  assert.equal(await run(["live", "site-v0.9.0", A], env, deps), 1);
  assert.equal(w.heads["site-live"], B);
  assert.ok(lines.some((l) => l.includes("cannot fast-forward")));
  assert.ok(lines.includes(ROLLBACK_HINT));
});

test("live: a failed LIVE smoke fails and writes no release", T, async () => {
  const w = liveWorld({ securityTxt: "nothing useful\n" });
  const { deps } = setup(w);
  assert.equal(await run(["live", "site-v1.0.0", B], env, deps), 1);
  assert.equal(w.releases.length, 0);
});

test("live: a re-run updates the existing release record instead of creating a second one", T, async () => {
  const w = liveWorld({ releases: [{ id: 7, tag: "site-v1.0.0", body: "old" }], heads: { "site-dev": B, "site-live": B } });
  const { deps } = setup(w);
  assert.equal(await run(["live", "site-v1.0.0", B], env, deps), 0);
  assert.equal(w.releases.length, 1);
  assert.ok(w.releases[0]?.body.includes(`Commit: ${B}`));
});

test("fastForward: already at the commit is a success and pushes nothing", T, async () => {
  const w = world({ heads: { "site-dev": B } });
  const { deps } = setup(w);
  assert.equal(await fastForward({ token: TOKEN, key: KEY, deps }, "site-dev", B), "already");
  assert.ok(w.calls.every((c) => c.method === "GET"));
});

test("errors from GitHub carry no token even if the server echoes it", T, async () => {
  const lines: string[] = [];
  const deps: Deps = {
    cwd: CWD,
    path: TEST_PATH,
    git: () => ({ status: 0, stderr: "" }),
    fetch: (async () => json(401, { message: `Bad credentials ${TOKEN}` })) as typeof fetch,
    now: () => 0,
    sleep: async () => {},
    log: (l) => lines.push(l),
  };
  assert.equal(await run(["dev", B], env, deps), 1);
  assert.ok(lines.some((l) => l.includes("HTTP 401")));
  assert.ok(!lines.join("\n").includes("TESTONLY"));
});

test("a network error is reported without the token", T, async () => {
  const deps: Deps = {
    cwd: CWD,
    path: TEST_PATH,
    git: () => ({ status: 0, stderr: "" }),
    fetch: (async () => {
      throw new Error(`connect failed for ${TOKEN}`);
    }) as typeof fetch,
    now: () => 0,
    sleep: async () => {},
    log: () => {},
  };
  await assert.rejects(
    () => import("./site-deploy.ts").then((m) => m.requireOnMain({ token: TOKEN, key: KEY, deps }, B)),
    (e: Error) => !e.message.includes("TESTONLY") && /connect failed/.test(e.message),
  );
});

test("pollVersion: tolerates errors and wrong answers, returns when the SHA shows", T, async () => {
  let n = 0;
  let clock = 0;
  const deps: Deps = {
    cwd: CWD,
    path: TEST_PATH,
    git: () => ({ status: 0, stderr: "" }),
    fetch: (async () => {
      n++;
      if (n === 1) throw new Error("boom");
      if (n === 2) return new Response("x", { status: 502 });
      if (n === 3) return new Response("unknown\n", { status: 200 });
      return new Response(`${B.toUpperCase()}\n`, { status: 200 });
    }) as typeof fetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    log: () => {},
  };
  const r = await pollVersion(deps, "https://x.test", B, { timeoutMs: 600_000, intervalMs: 1000 });
  assert.equal(r.answer.toLowerCase(), B);
  assert.equal(n, 4);
});

test("smoke: reports each path; a 404 robots.txt fails", T, async () => {
  const deps: Deps = {
    cwd: CWD,
    path: TEST_PATH,
    git: () => ({ status: 0, stderr: "" }),
    fetch: (async (input: string | URL | Request) => {
      const p = new URL(String(input)).pathname;
      if (p === "/robots.txt") return new Response("", { status: 404 });
      if (p === "/.well-known/security.txt") return new Response("Contact: mailto:a@b.test", { status: 200 });
      return new Response("ok", { status: 200 });
    }) as typeof fetch,
    now: () => 0,
    sleep: async () => {},
    log: () => {},
  };
  const r = await smoke(deps, "https://x.test");
  assert.deepEqual(
    r.map((x) => [x.path, x.ok]),
    [
      ["/", true],
      ["/robots.txt", false],
      ["/.well-known/security.txt", true],
    ],
  );
});

test("releaseBody: commit, answer, smoke results and the three UTC times", T, () => {
  const body = releaseBody({
    tag: "site-v1.2.3",
    sha: B,
    answer: B,
    url: "https://tealbrick.com",
    results: [{ path: "/", ok: true, detail: "HTTP 200" }],
    startedAt: Date.parse("2026-10-20T10:00:00Z"),
    seenAt: Date.parse("2026-10-20T10:03:30Z"),
    finishedAt: Date.parse("2026-10-20T10:03:31Z"),
  });
  for (const part of [`Commit: ${B}`, `answered: ${B}`, "10:00:00Z", "10:03:30Z", "10:03:31Z", "- /: ok (HTTP 200)"]) assert.ok(body.includes(part), part);
});

// ---- C293a: the push uses the deploy key over SSH, never --force ----

test("push: plain git push of <sha>:refs/heads/<branch> with the key in a 0600 file, pinned host key, no --force, key file gone afterwards", T, async () => {
  const w = world();
  const { deps } = setup(w);
  assert.equal(await run(["dev", B], env, deps), 0);
  const g = w.gitCalls[0];
  assert.deepEqual(g?.args, ["-c", "core.hooksPath=/dev/null", "push", "--no-verify", SSH_REMOTE, `${B}:refs/heads/site-dev`]);
  assert.ok(!(g?.args ?? []).some((a) => /^--?f(orce)?|force|\+/.test(a)), "no --force, no +refspec");
  assert.equal(g?.keyMode, 0o600);
  assert.equal(g?.keyText, `${KEY}\n`);
  assert.equal(g?.hostsText, `${GITHUB_HOST_KEY}\n`);
  const ssh = g?.env.GIT_SSH_COMMAND ?? "";
  assert.match(ssh, /-o IdentitiesOnly=yes/);
  assert.match(ssh, /-o StrictHostKeyChecking=yes/);
  assert.match(ssh, /-o UserKnownHostsFile=\S+/);
  assert.equal(g?.env.GIT_TERMINAL_PROMPT, "0");
  assert.ok(!existsSync(g?.keyFile ?? "x"), "the key file is deleted after the push");
  assert.ok(!(g?.args ?? []).join(" ").includes(KEY_BODY), "the key is never in argv");
});

test("push: a non-fast-forward rejection fails the run, no polling, no release", T, async () => {
  const w = liveWorld({ push: "reject" });
  const { deps, lines } = setup(w);
  assert.equal(await run(["live", "site-v1.0.0", B], env, deps), 1);
  assert.ok(lines.some((l) => l.includes("refused or failed") && l.includes("non-fast-forward")));
  assert.equal(w.releases.length, 0);
  assert.ok(!w.calls.some((c) => c.url.includes("/version.txt")), "nothing is polled after a failed push");
  assert.ok(!existsSync(w.gitCalls[0]?.keyFile ?? "x"));
});

test("push: no key or token text in any output, even when git echoes them", T, async () => {
  const w = world({ push: "leak" });
  const { deps, lines } = setup(w);
  assert.equal(await run(["dev", B], env, deps), 1);
  const out = lines.join("\n");
  for (const secret of [KEY_BODY, "BEGIN OPENSSH", TOKEN, "TESTONLY"]) assert.ok(!out.includes(secret), `output holds ${secret.slice(0, 8)}`);
  assert.ok(out.includes("refused or failed"));
});

test("push: a missing or malformed key is refused before any call", T, async () => {
  for (const bad of [undefined, "", "not a key", "ssh-ed25519 AAAA public"]) {
    const w = world();
    const { deps } = setup(w);
    assert.equal(await run(["dev", B], { PLUGIN_TOKEN: TOKEN, ...(bad === undefined ? {} : { PLUGIN_DEPLOY_KEY: bad }) }, deps), 1);
    assert.equal(w.calls.length, 0);
    assert.equal(w.gitCalls.length, 0);
  }
});

test("redact: removes the key block and each key line", T, () => {
  const out = redact(`x ${KEY} y ${KEY_BODY} z`, TOKEN, KEY);
  assert.ok(!out.includes(KEY_BODY) && !out.includes("PRIVATE KEY"));
});

// ---- S2-a: a moved tag ----

test("S2-a live: the tag now points to another main commit than the one CI ran on -> refused, nothing pushed", T, async () => {
  const w = liveWorld({ tags: { "site-v1.0.0": { type: "commit", sha: B } } });
  const { deps, lines } = setup(w);
  assert.equal(await run(["live", "site-v1.0.0", A], env, deps), 1);
  assert.ok(lines.some((l) => l.includes("the tag was moved")));
  assert.equal(w.gitCalls.length, 0);
  assert.equal(w.heads["site-live"], A);
  assert.equal(w.releases.length, 0);
});

test("S2-a live: the commit CI ran on must be a full SHA", T, async () => {
  const w = liveWorld();
  const { deps } = setup(w);
  assert.equal(await run(["live", "site-v1.0.0", "main"], env, deps), 1);
  assert.equal(w.calls.length, 0);
});

// ---- S3-a: a tag named main ----

test('S3-a: a tag named "main" does not change the on-main check (main is resolved to a SHA first)', T, async () => {
  // The fake compare API resolves a bare "main" to the TAG (commit C, apart from main). A client that compared against the name would refuse B.
  const w = world({ mainTag: C });
  const { deps } = setup(w);
  assert.equal(await run(["dev", B], env, deps), 0);
  assert.ok(w.calls.some((c) => c.url.endsWith("/git/ref/heads/main")));
  assert.ok(
    w.calls.every((c) => !/\.\.\.main(\?|$)/.test(c.url)),
    "compare never uses the bare name main",
  );
  // and a commit that is NOT on main is still refused
  const w2 = world({ mainTag: B });
  const { deps: d2 } = setup(w2);
  assert.equal(await run(["dev", C], env, d2), 1);
});

// ---- Trust: the candidate is verified against GitHub ----

const CTX = "ci/woodpecker/push/ci";

test("trust: a commit without a green ci/woodpecker/push/ci is refused (failure, error, other context only)", T, async () => {
  assert.equal(CI_CONTEXT, CTX);
  for (const st of [[{ context: CTX, state: "failure" }], [{ context: CTX, state: "error" }], [{ context: "ci/woodpecker/pr/ci", state: "success" }]]) {
    for (const argv of [
      ["dev", B],
      ["live", "site-v1.0.0", B],
    ]) {
      const w = world({ statuses: { [B]: st } });
      const { deps, lines } = setup(w);
      assert.equal(await run(argv, env, deps), 1, JSON.stringify([st, argv]));
      assert.equal(w.gitCalls.length, 0, "nothing is pushed");
      assert.equal(w.releases.length, 0);
      assert.ok(lines.some((l) => l.includes(CTX)));
    }
  }
});

test("trust: a pending status is awaited, then accepted when it turns green", T, async () => {
  let n = 0;
  const w = world({ statuses: { [B]: () => [{ context: CTX, state: ++n < 3 ? "pending" : "success" }] } });
  const { deps } = setup(w);
  assert.equal(await run(["dev", B], env, deps), 0);
  assert.equal(n, 3);
  assert.equal(w.gitCalls.length, 1);
});

test("trust: a status that stays pending or missing is refused after 3 minutes", T, async () => {
  for (const st of [[{ context: CTX, state: "pending" }], []]) {
    const w = world({ statuses: { [B]: st } });
    const { deps, lines, tick } = setup(w);
    const start = tick();
    assert.equal(await run(["dev", B], env, deps), 1);
    assert.ok(tick() - start <= 3 * 60 * 1000 && tick() - start >= 2 * 60 * 1000);
    assert.ok(lines.some((l) => /after 3 min/.test(l)));
    assert.equal(w.gitCalls.length, 0);
  }
});

test("trust: repo, branches and URLs are constants: no setting (PLUGIN_REPO, PLUGIN_BRANCH, PLUGIN_URL ...) changes them", T, async () => {
  const w = world();
  const { deps } = setup(w);
  const evil = {
    ...env,
    PLUGIN_REPO: "evil/repo",
    PLUGIN_DEV_URL: "https://evil.example",
    PLUGIN_BRANCH: "main",
    PLUGIN_LIVE_BRANCH: "main",
    SITE_REPO: "evil/repo",
  };
  assert.equal(await run(["dev", B], evil, deps), 0);
  for (const c of w.calls) assert.ok(c.url.startsWith("https://api.github.com/repos/Tealbrick/opt2-tealbrick-website/") || c.url.startsWith(DEV_URL), c.url);
  assert.deepEqual(w.gitCalls[0]?.args, ["-c", "core.hooksPath=/dev/null", "push", "--no-verify", SSH_REMOTE, `${B}:refs/heads/site-dev`]);
  assert.equal(SSH_REMOTE, "git@github.com:Tealbrick/opt2-tealbrick-website.git");
});

test("trust: only site-dev and site-live can be moved (a branch name from elsewhere is refused)", T, async () => {
  const w = world({ heads: { main: A, "site-dev": A, "site-live": A } });
  const { deps } = setup(w);
  const ctx = { token: TOKEN, key: KEY, deps };
  for (const branch of ["main", "feat/x", "site-dev/../main", ""]) {
    await assert.rejects(() => fastForward(ctx, branch, B), /refusing to move/);
  }
  const { pushBranch } = await import("./site-deploy.ts");
  assert.throws(() => pushBranch(ctx, "main", B), /refusing to push/);
  assert.throws(() => pushBranch(ctx, "site-live", "main"), /refusing to push/);
  assert.equal(w.gitCalls.length, 0);
});

test("trust: live reads the tag from GitHub; a tag that does not point at the candidate is refused", T, async () => {
  const w = liveWorld({ tags: { "site-v1.0.0": { type: "commit", sha: A } } });
  const { deps, lines } = setup(w);
  assert.equal(await run(["live", "site-v1.0.0", B], env, deps), 1);
  assert.ok(w.calls.some((c) => c.url.endsWith("/git/ref/tags/site-v1.0.0")));
  assert.ok(lines.some((l) => l.includes("the tag was moved")));
  assert.equal(w.gitCalls.length, 0);
});

test("trust: an annotated tag is peeled to its commit before the comparison", T, async () => {
  const w = liveWorld({ tags: { "site-v1.0.0": { type: "tag", sha: "e".repeat(40), inner: A } } });
  const { deps } = setup(w);
  assert.equal(await run(["live", "site-v1.0.0", B], env, deps), 1, "peeled to A, candidate is B: refused");
  const w2 = liveWorld({ tags: { "site-v1.0.0": { type: "tag", sha: "e".repeat(40), inner: B } } });
  const { deps: d2 } = setup(w2);
  assert.equal(await run(["live", "site-v1.0.0", B], env, d2), 0);
});

test("trust: main ahead of the candidate is accepted, equal is accepted, not-on-main and behind-main-line-apart are refused", T, async () => {
  const D = "d".repeat(40);
  const w = world({ mainLine: [A, B, D], main: D, statuses: {}, devVersion: [B] });
  const { deps } = setup(w);
  assert.equal(await run(["dev", B], env, deps), 0, "B is behind main D: on main");
  const w3 = world({ mainLine: [A, B], main: B });
  const { deps: d3 } = setup(w3);
  assert.equal(await run(["dev", B], env, d3), 0, "B equals main: on main");
  const w2 = world({ mainLine: [A, B], main: B });
  const { deps: d2 } = setup(w2);
  assert.equal(await run(["dev", C], env, d2), 1, "C is on another line: refused");
});

// ---- C293a round 3: the plugin on a writer's test branch, and the image recipe ----

test('rollout test: dev mode on a test-branch commit (not on main) refuses with "is not on main", pushes nothing, writes no release', T, async () => {
  const BRANCH_COMMIT = "9".repeat(40);
  const w = world();
  const { deps, lines } = setup(w);
  assert.equal(await runPlugin({ ...env, PLUGIN_MODE: "dev", CI_COMMIT_SHA: BRANCH_COMMIT }, deps), 1);
  assert.ok(lines.some((l) => l.includes("is not on main")));
  assert.equal(w.gitCalls.length, 0);
  assert.equal(w.releases.length, 0);
});

test("rollout test: live mode without a tag (a branch pipeline) is refused before any push", T, async () => {
  const w = liveWorld();
  const { deps, lines } = setup(w);
  assert.equal(await runPlugin({ ...env, PLUGIN_MODE: "live", CI_COMMIT_SHA: B }, deps), 1);
  assert.ok(lines.some((l) => l.includes("is not a website tag")));
  assert.equal(w.gitCalls.length, 0);
});

test("Dockerfile: base pinned by digest, git + openssh-client, non-root user, the plugin as ENTRYPOINT; VERSION is X.Y.Z", T, () => {
  const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^FROM node:24-alpine@sha256:[0-9a-f]{64}$/m);
  assert.match(dockerfile, /apk add --no-cache git openssh-client/);
  assert.match(dockerfile, /^USER deploy$/m);
  assert.match(dockerfile, /^ENTRYPOINT \["node", "\/app\/site-deploy\.ts"\]$/m);
  assert.match(dockerfile, /^COPY site-deploy\.ts VERSION \.\/$/m);
  assert.match(readFileSync(new URL("./VERSION", import.meta.url), "utf8").trim(), /^1\.0\.0$/);
});

test("the plugin file imports nothing from the repo (it is copied alone into the image)", T, () => {
  const src = readFileSync(new URL("./site-deploy.ts", import.meta.url), "utf8");
  const imports = [...src.matchAll(/^import .* from ["']([^"']+)["'];$/gm)];
  assert.ok(imports.length >= 4, "the imports were found");
  for (const m of imports) assert.match(m[1] as string, /^node:/, `import ${m[1]}`);
});

// ---- Round 4: LIVE only takes a commit DEV already has ----

const DEV_MSG = "this commit has not been deployed to DEV yet: merge to main, wait for DEV, then tag";

test("DEV gate: sha == site-dev -> LIVE deploys", T, async () => {
  const w = liveWorld({ heads: { "site-dev": B, "site-live": A } });
  const { deps } = setup(w);
  assert.equal(await run(["live", "site-v1.0.0", B], env, deps), 0);
  assert.ok(
    w.calls.some((c) => c.url.endsWith("/git/ref/heads/site-dev")),
    "site-dev is read fresh",
  );
});

test("DEV gate: sha older than site-dev (DEV has moved on) -> LIVE deploys", T, async () => {
  const D = "d".repeat(40);
  const w = liveWorld({ mainLine: [A, B, D], main: D, heads: { "site-dev": D, "site-live": A } });
  const { deps } = setup(w);
  assert.equal(await run(["live", "site-v1.0.0", B], env, deps), 0);
  assert.equal(w.heads["site-live"], B);
});

test("DEV gate: sha newer than site-dev (on main, not on DEV yet) -> refused with the DEV message, nothing pushed, no release", T, async () => {
  const w = liveWorld({ heads: { "site-dev": A, "site-live": A } });
  const { deps, lines } = setup(w);
  assert.equal(await run(["live", "site-v1.0.0", B], env, deps), 1);
  assert.ok(lines.some((l) => l.includes(DEV_MSG)));
  assert.equal(w.gitCalls.length, 0);
  assert.equal(w.releases.length, 0);
  assert.equal(w.heads["site-live"], A);
});

test("DEV gate: sha diverged from site-dev -> refused", T, async () => {
  const w = liveWorld({ heads: { "site-dev": C, "site-live": A } });
  const { deps, lines } = setup(w);
  assert.equal(await run(["live", "site-v1.0.0", B], env, deps), 1);
  assert.ok(lines.some((l) => l.includes(DEV_MSG)));
  assert.equal(w.gitCalls.length, 0);
});

test("DEV gate: a missing site-dev branch -> refused", T, async () => {
  const w = liveWorld({ heads: { "site-live": A } });
  const { deps, lines } = setup(w);
  assert.equal(await run(["live", "site-v1.0.0", B], env, deps), 1);
  assert.ok(lines.some((l) => l.includes("site-dev does not exist")));
  assert.equal(w.gitCalls.length, 0);
});

test("DEV gate: the dev mode does not need it (DEV is the first stop)", T, async () => {
  const w = world();
  const { deps } = setup(w);
  assert.equal(await run(["dev", B], env, deps), 0);
});

// ---- Round 4 S4: git runs in a fresh repo with a minimal environment ----

test("S4: git runs in a fresh bare repo in a temp folder: init first, GIT_DIR set, no hooks, --no-verify, objects read through alternates", T, async () => {
  const w = world();
  const { deps } = setup(w);
  const workspace = mkdtempSync(join(tmpdir(), "ws-"));
  await pushBranchWith(deps, workspace, "site-dev", B);
  const init = w.gitInits[0];
  assert.deepEqual(init?.args.slice(0, 4), ["init", "--bare", "--quiet", "--template="]);
  const push = w.gitCalls[0];
  assert.deepEqual(push?.args, ["-c", "core.hooksPath=/dev/null", "push", "--no-verify", SSH_REMOTE, `${B}:refs/heads/site-dev`]);
  assert.ok(!push?.args.includes("--force") && !push?.args.some((a) => a.startsWith("+")));
  assert.equal(push?.env.GIT_DIR, init?.args[4], "git works in the temp repo, not in the workspace");
  assert.ok(!(push?.env.GIT_DIR ?? "").startsWith(workspace));
  assert.equal(push?.env.GIT_ALTERNATE_OBJECT_DIRECTORIES, join(workspace, ".git", "objects"));
  assert.match(push?.env.GIT_SSH_COMMAND ?? "", /-F \/dev\/null /);
});

/** pushBranch with the mocked git of `deps` and a workspace folder. */
async function pushBranchWith(deps: Deps, workspace: string, branch: string, sha: string): Promise<void> {
  pushBranch({ token: TOKEN, key: KEY, deps, workspace }, branch, sha);
}

test("S4: the git child gets a minimal environment: no PLUGIN_*, no CI_*, no secret, HOME is the temp folder", T, async () => {
  const saved = { t: process.env.PLUGIN_TOKEN, k: process.env.PLUGIN_DEPLOY_KEY, c: process.env.CI_COMMIT_SHA };
  process.env.PLUGIN_TOKEN = TOKEN;
  process.env.PLUGIN_DEPLOY_KEY = KEY;
  process.env.CI_COMMIT_SHA = B;
  try {
    const w = world();
    const { deps } = setup(w);
    assert.equal(await run(["dev", B], env, deps), 0);
    const allowed = new Set([
      "PATH",
      "HOME",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_TERMINAL_PROMPT",
      "GIT_DIR",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_SSH_COMMAND",
    ]);
    for (const e of [...w.gitInits.map((g) => g.env), ...w.gitCalls.map((g) => g.env)]) {
      for (const k of Object.keys(e)) assert.ok(allowed.has(k), `unexpected variable ${k}`);
      assert.ok(!Object.keys(e).some((k) => k.startsWith("PLUGIN_") || k.startsWith("CI_")));
      const text = JSON.stringify(e);
      assert.ok(!text.includes(TOKEN) && !text.includes(KEY_BODY), "no secret in the child environment");
      assert.equal(e.GIT_CONFIG_GLOBAL, "/dev/null");
      assert.equal(e.GIT_CONFIG_NOSYSTEM, "1");
    }
    const home = w.gitCalls[0]?.env.HOME ?? "";
    assert.ok(home.includes("site-deploy-") && home !== process.env.HOME, "HOME is a temp folder");
  } finally {
    for (const [k, v] of [
      ["PLUGIN_TOKEN", saved.t],
      ["PLUGIN_DEPLOY_KEY", saved.k],
      ["CI_COMMIT_SHA", saved.c],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.deepEqual(Object.keys(gitEnv("/h", "/bin")).sort(), ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "HOME", "PATH"]);
});

test("S4 real git: a hook in the workspace is NOT run, the workspace config is not read, and the commit reaches the remote", { timeout: 60_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "tb-s4-"));
  const sh = (cwd: string, args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.test",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.test",
        ...env,
      },
    });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const remote = join(root, "remote.git");
  sh(root, ["init", "--bare", "--quiet", remote]);
  const ws = join(root, "ws");
  mkdirSync(ws);
  sh(ws, ["init", "--quiet"]);
  writeFileSync(join(ws, "a.txt"), "one\n");
  sh(ws, ["add", "a.txt"]);
  sh(ws, ["commit", "--quiet", "-m", "one"]);
  const sha = sh(ws, ["rev-parse", "HEAD"]);
  // evil workspace: hooks of every push kind, a hooksPath config and a url rewrite that would redirect the push
  const marker = join(root, "HOOK-RAN");
  const hookDir = join(ws, "evil-hooks");
  mkdirSync(hookDir);
  for (const name of ["pre-push", "reference-transaction", "pre-commit"]) {
    writeFileSync(join(hookDir, name), `#!/bin/sh\necho ran > "${marker}"\n`);
    chmodSync(join(hookDir, name), 0o755);
  }
  for (const name of ["pre-push"]) {
    writeFileSync(join(ws, ".git", "hooks", name), `#!/bin/sh\necho ran > "${marker}"\n`);
    chmodSync(join(ws, ".git", "hooks", name), 0o755);
  }
  sh(ws, ["config", "core.hooksPath", hookDir]);
  sh(ws, ["config", `url.file:///nowhere/.insteadOf`, `file://${remote}`]);
  sh(ws, ["config", "core.sshCommand", `touch ${marker}`]);
  const deps: Deps = {
    cwd: CWD,
    path: process.env.PATH ?? TEST_PATH,
    fetch: (async () => new Response("{}")) as typeof fetch,
    git: (args, e) => {
      const r = spawnSync("git", args, { env: e, encoding: "utf8" });
      return { status: r.status, stderr: r.stderr ?? "" };
    },
    now: () => 0,
    sleep: async () => {},
    log: () => {},
  };
  pushBranch({ token: TOKEN, key: KEY, deps }, "site-dev", sha, `file://${remote}`, ws);
  assert.ok(!existsSync(marker), "no hook and no workspace config ran");
  assert.equal(sh(remote, ["rev-parse", "refs/heads/site-dev"]), sha);
});

// ---- Round 4 fix: the runner's own environment and workspace must not matter ----

test("a shallow workspace (the Woodpecker clone) does not break the push: the boundary is copied into the temp repo", T, async () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-shallow-"));
  mkdirSync(join(ws, ".git"));
  writeFileSync(join(ws, ".git", "shallow"), `${A}\n`);
  const w = world();
  const { deps } = setup(w);
  pushBranch({ token: TOKEN, key: KEY, deps, workspace: ws }, "site-dev", B);
  assert.equal(w.gitCalls.length, 1);
  assert.equal(w.gitCalls[0]?.env.GIT_ALTERNATE_OBJECT_DIRECTORIES, join(ws, ".git", "objects"));
});

test("the runner's environment (CI=true, CI_*, PLUGIN_*) and its cwd change nothing: the plugin only sees the env it is given", T, async () => {
  const keys = [
    "CI",
    "CI_COMMIT_SHA",
    "CI_COMMIT_TAG",
    "CI_WORKSPACE",
    "CI_PIPELINE_NUMBER",
    "PLUGIN_MODE",
    "PLUGIN_TOKEN",
    "PLUGIN_DEPLOY_KEY",
    "PLUGIN_REPO",
  ] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  for (const k of keys) process.env[k] = k === "CI_COMMIT_SHA" ? "deadbeef" : k === "PLUGIN_MODE" ? "live" : "x";
  try {
    const w = world();
    const { deps } = setup(w);
    // explicit env, no inherited CI_*/PLUGIN_*: mode and the candidate come only from here
    assert.equal(await runPlugin({ PLUGIN_MODE: "dev", PLUGIN_TOKEN: TOKEN, PLUGIN_DEPLOY_KEY: KEY, CI_COMMIT_SHA: B }, deps), 0);
    assert.equal(w.heads["site-dev"], B);
    const text = JSON.stringify(w.gitCalls.map((g) => g.env));
    assert.ok(!text.includes('"x"') && !text.includes("deadbeef"), "nothing of the runner environment reaches git");
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
