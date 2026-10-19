// C187 (5): Martin enters the secrets of the opt2 `live` environment (PROD). Agents never run the real mode.
// C231: STRIPE_SECRET_KEY takes a LIVE restricted key (rk_live_) or a TEST key; Core charges only with TB_STRIPE_ALLOW_LIVE=1.
//   node ops/prod-secrets.ts --dry-run                 lists the variable NAMES this script sets (no Railway call, no prompt)
//   node ops/prod-secrets.ts [--environment live]      generates TB_KEK, asks for the provider secrets (hidden input) and
//                                                      sets them with `railway variable set <NAME> --stdin --skip-deploys`
//   options: --only NAME[,NAME…]  set only these names (e.g. to replace one wrong value; TB_KEK is never replaced)
// Rules: values are never printed, never on argv, never in a file. Nothing is deployed (--skip-deploys); the cutover lead
// deploys pinned SHAs afterwards (C141). The dev environment `production` is refused. An existing TB_KEK is never replaced:
// a new KEK makes every sealed value unreadable (KEK rotation = ops/KEYS.md, not this script).
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const PROJECT = "15297ce5-0283-4901-a408-9c802e6ac53a"; // Railway project "opt2"
export const DEV_ENVIRONMENT = "production"; // the dev environment (dev.tealbrick.com); never a target of this script

export type Source = "generated" | "prompt";
export interface SecretSpec {
  name: string;
  service: "portal-core" | "portal-gui" | "db-backup";
  source: Source;
  required: boolean;
  /** what Martin pastes, in the prompt */
  label: string;
  /** null = any non-empty value */
  pattern: RegExp | null;
  /** why the value is refused, shown on a pattern mismatch (never shows the value) */
  hint: string;
}

/** Every secret of the live environment. Non-secret config is set by the cutover lead (PROD-NOW-RUNBOOK env matrix). */
export const SECRETS: readonly SecretSpec[] = [
  { name: "TB_KEK", service: "portal-core", source: "generated", required: true, label: "Core key-encryption key", pattern: null, hint: "" },
  { name: "TB_KEK_ID", service: "portal-core", source: "generated", required: true, label: "id of TB_KEK (not secret)", pattern: null, hint: "" },
  {
    name: "CLERK_SECRET_KEY",
    service: "portal-core",
    source: "prompt",
    required: true,
    label: "Clerk PRODUCTION secret key (sk_live_…)",
    pattern: /^sk_live_[A-Za-z0-9]{20,}$/,
    hint: "must start with sk_live_ (Clerk production instance)",
  },
  {
    name: "CLERK_PUBLISHABLE_KEY",
    service: "portal-core",
    source: "prompt",
    required: true,
    label: "Clerk PRODUCTION publishable key (pk_live_…)",
    pattern: /^pk_live_[A-Za-z0-9+/=_-]{10,}$/,
    hint: "must start with pk_live_ (Clerk production instance)",
  },
  {
    name: "CLERK_WEBHOOK_SECRET",
    service: "portal-core",
    source: "prompt",
    required: true,
    label: "Clerk webhook signing secret of the portal.tealbrick.com endpoint (whsec_…)",
    pattern: /^whsec_[A-Za-z0-9+/=]{20,}$/,
    hint: "must start with whsec_",
  },
  {
    name: "STRIPE_SECRET_KEY",
    service: "portal-core",
    source: "prompt",
    required: true,
    label: "Stripe key: LIVE restricted key (rk_live_…, charges real money) or TEST key (rk_test_… / sk_test_…, to roll back)",
    // C231: a LIVE key only as a restricted key (least privilege); Core still refuses it until TB_STRIPE_ALLOW_LIVE=1.
    pattern: /^(rk_live|rk_test|sk_test)_[A-Za-z0-9]{20,}$/,
    hint: "must be a LIVE restricted key (rk_live_) or a TEST key (rk_test_ / sk_test_); a full live secret key (sk_live_) is refused",
  },
  {
    name: "STRIPE_WEBHOOK_SECRET",
    service: "portal-core",
    source: "prompt",
    required: true,
    label: "Stripe webhook signing secret of https://portal.tealbrick.com/api/v1/stripe/webhook, in the SAME mode as the key (whsec_…)",
    pattern: /^whsec_[A-Za-z0-9]{20,}$/,
    hint: "must start with whsec_",
  },
  {
    name: "RAILWAY_OAUTH_CLIENT_ID",
    service: "portal-core",
    source: "prompt",
    required: true,
    label: "Railway OAuth app client id",
    pattern: /^\S{8,}$/,
    hint: "at least 8 characters, no spaces",
  },
  {
    name: "RAILWAY_OAUTH_CLIENT_SECRET",
    service: "portal-core",
    source: "prompt",
    required: true,
    label: "Railway OAuth app client secret",
    pattern: /^\S{16,}$/,
    hint: "at least 16 characters, no spaces",
  },
  {
    name: "RAILWAY_REFERRAL_CODE",
    service: "portal-core",
    source: "prompt",
    required: false,
    label: "Railway referral code (Enter = skip)",
    pattern: /^[A-Za-z0-9_-]{1,64}$/,
    hint: "letters, digits, - and _ only",
  },
  {
    name: "SENTRY_DSN",
    service: "portal-core",
    source: "prompt",
    required: false,
    label: "GlitchTip DSN for Core in live (Enter = skip)",
    pattern: /^https:\/\/\S+$/,
    hint: "must be an https URL",
  },
  {
    name: "HEARTBEAT_URL",
    service: "db-backup",
    source: "prompt",
    required: false,
    label: "GlitchTip heartbeat URL for the live db-backup (Enter = skip)",
    pattern: /^https:\/\/\S+$/,
    hint: "must be an https URL",
  },
];

export interface Options {
  environment: string;
  dryRun: boolean;
  only: string[] | null;
}

export function parseArgs(argv: readonly string[]): Options {
  const val = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  const known = new Set(["--dry-run", "--environment", "--only"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) continue;
    if (!known.has(a)) throw new Error(`unknown option ${a}`);
  }
  const environment = val("--environment") ?? "live";
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(environment)) throw new Error("--environment must be a Railway environment name (lower case)");
  if (environment === DEV_ENVIRONMENT) throw new Error(`refusing environment "${DEV_ENVIRONMENT}": it is the dev environment (dev.tealbrick.com)`);
  const onlyRaw = val("--only");
  const only = onlyRaw
    ? onlyRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
  if (only) {
    const names = new Set(SECRETS.map((s) => s.name));
    for (const n of only) if (!names.has(n)) throw new Error(`--only: ${n} is not a secret this script sets`);
  }
  return { environment, dryRun: argv.includes("--dry-run"), only };
}

/** The specs to handle for these options; TB_KEK and TB_KEK_ID always travel together. */
export function selectSpecs(only: string[] | null): SecretSpec[] {
  if (!only) return [...SECRETS];
  const want = new Set(only);
  if (want.has("TB_KEK") || want.has("TB_KEK_ID")) {
    want.add("TB_KEK");
    want.add("TB_KEK_ID");
  }
  return SECRETS.filter((s) => want.has(s.name));
}

/** Dry-run output: names, services and sources only. Never a value. */
export function planLines(specs: readonly SecretSpec[], environment: string): string[] {
  const lines = [`project opt2, environment ${environment} — variables this script sets (names only):`];
  for (const s of specs)
    lines.push(
      `  ${s.service.padEnd(12)} ${s.name.padEnd(28)} ${s.source === "generated" ? "generated here" : s.required ? "you paste it" : "you paste it (optional)"}`,
    );
  lines.push("nothing is deployed (--skip-deploys)");
  return lines;
}

/** Checks a pasted value. Returns null when accepted, else the reason (never contains the value). */
export function checkValue(spec: SecretSpec, value: string): string | null {
  if (value === "") return spec.required ? "a value is required" : null;
  if (/\s/.test(value)) return "the value contains spaces or line breaks";
  if (spec.pattern && !spec.pattern.test(value)) return spec.hint;
  return null;
}

/** C231: what the operator must know after setting a Stripe key (the mode only, never the value). */
export function stripeModeNotes(collected: readonly { spec: { name: string }; value: string }[]): string[] {
  const key = collected.find((c) => c.spec.name === "STRIPE_SECRET_KEY")?.value;
  if (!key) return [];
  const notes: string[] = [];
  if (key.startsWith("rk_live_")) {
    notes.push("STRIPE_SECRET_KEY is a LIVE key. Core runs live only after the cutover lead sets TB_STRIPE_ALLOW_LIVE=1 and removes TB_STRIPE_QA_PROMO.");
    if (!collected.some((c) => c.spec.name === "STRIPE_WEBHOOK_SECRET"))
      notes.push("Also set STRIPE_WEBHOOK_SECRET from the LIVE webhook endpoint (--only STRIPE_WEBHOOK_SECRET): a test-mode secret cannot verify live events.");
  } else notes.push("STRIPE_SECRET_KEY is a TEST key. Core runs in Stripe test mode; the cutover lead removes TB_STRIPE_ALLOW_LIVE.");
  return notes;
}

/** C35: 32 random bytes, base64url (43 characters), the format Core's kekFromEnv reads. */
export function generateKek(rand: (n: number) => Buffer = randomBytes): string {
  const key = rand(32);
  if (key.length !== 32) throw new Error("random source returned the wrong length");
  return key.toString("base64url");
}

/** The same id Core derives when TB_KEK_ID is absent (manifest kekFromEnv): kek_<first 16 hex of sha256("tb:kek-id:" || key)>. */
export function kekIdOf(kek: string): string {
  const key = Buffer.from(kek, "base64url");
  if (key.length !== 32) throw new Error("TB_KEK must decode to 32 bytes");
  return `kek_${createHash("sha256").update("tb:kek-id:").update(key).digest("hex").slice(0, 16)}`;
}

/** Removes every secret value from a text before it is shown (Railway CLI error output). */
export function redact(text: string, values: readonly string[]): string {
  let out = text;
  for (const v of values) if (v.length >= 4) out = out.split(v).join("***");
  return out;
}

/** Arguments for one `railway variable set` call; the value goes to stdin, never into argv. */
export function railwaySetArgs(name: string, service: string, environment: string): string[] {
  return ["variable", "set", name, "--stdin", "--skip-deploys", "--service", service, "--environment", environment];
}

async function askHidden(prompt: string): Promise<string> {
  // Raw-mode reader: readline clears the prompt line on a TTY (cursorTo + clearScreenDown), so the prompt vanished.
  process.stderr.write(`${prompt}(hidden: paste with Cmd+V, nothing shows, then press Enter) `);
  const stdin = process.stdin;
  return await new Promise<string>((resolve, reject) => {
    let buf = "";
    const done = (fn: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      fn();
    };
    const onData = (chunk: Buffer) => {
      // bracketed-paste markers from some terminals
      const text = chunk
        .toString("utf8")
        .replaceAll(`${String.fromCharCode(27)}[200~`, "")
        .replaceAll(`${String.fromCharCode(27)}[201~`, "");
      for (const ch of text) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(buf.trim()));
        if (ch === "\u0003") return done(() => reject(new Error("stopped (Ctrl+C); nothing was set yet")));
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const answer = await new Promise<string>((r) => rl.question(prompt, r));
  rl.close();
  return answer.trim();
}

function railway(args: string[], cwd: string, input?: string): { ok: boolean; err: string } {
  const r = spawnSync("railway", args, { cwd, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  return { ok: r.status === 0, err: `${r.stderr ?? ""}${r.stdout ?? ""}`.trim() };
}

/** Names already set on a service (values are read by the CLI and dropped here; never printed). */
function existingNames(cwd: string, service: string, environment: string): Set<string> {
  const r = spawnSync("railway", ["variable", "list", "--json", "--service", service, "--environment", environment], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cannot list variable names of ${service} (is the environment "${environment}" created?)`);
  return new Set(Object.keys(JSON.parse(r.stdout) as Record<string, unknown>));
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const specs = selectSpecs(opts.only);
  if (opts.dryRun) {
    for (const l of planLines(specs, opts.environment)) console.log(l);
    return;
  }
  if (!process.stdin.isTTY) throw new Error("run this in a terminal (hidden input needs a TTY); values are never read from a pipe");
  if (spawnSync("railway", ["whoami"], { stdio: "ignore" }).status !== 0) throw new Error("log in to the Railway CLI first: railway login");

  // The Railway CLI acts on a linked directory: link a private temporary folder to project opt2 / the target environment.
  const dir = mkdtempSync(join(tmpdir(), "tb-prod-secrets-"));
  const values: string[] = [];
  try {
    const link = railway(["link", "--project", PROJECT, "--environment", opts.environment], dir);
    if (!link.ok) throw new Error(`railway link failed (environment "${opts.environment}" in project opt2?): ${link.err.slice(0, 300)}`);

    const core = existingNames(dir, "portal-core", opts.environment);
    for (const l of planLines(specs, opts.environment)) console.log(l);
    if (specs.some((s) => s.name === "TB_KEK") && core.has("TB_KEK")) {
      throw new Error("TB_KEK is already set in this environment; a new KEK would lock every sealed value. Run again with --only and the other names.");
    }
    const go = await ask(`Type SET to set these ${specs.length} variables in "${opts.environment}": `);
    if (go !== "SET") throw new Error("stopped; nothing was changed");

    const collected: { spec: SecretSpec; value: string }[] = [];
    let kek: string | null = null;
    for (const spec of specs) {
      if (spec.name === "TB_KEK") {
        kek = generateKek();
        values.push(kek);
        collected.push({ spec, value: kek });
        continue;
      }
      if (spec.name === "TB_KEK_ID") {
        if (!kek) throw new Error("TB_KEK_ID without TB_KEK");
        collected.push({ spec, value: kekIdOf(kek) });
        continue;
      }
      for (let attempt = 1; ; attempt++) {
        const v = await askHidden(`${spec.label}: `);
        const why = checkValue(spec, v);
        if (!why) {
          if (v !== "") {
            values.push(v);
            collected.push({ spec, value: v });
            console.log(`  received ${spec.name}: ${v.length} characters, starts with "${v.slice(0, Math.min(8, Math.floor(v.length / 4)))}…"`);
          } else console.log(`  ${spec.name}: skipped`);
          break;
        }
        console.log(`  ${spec.name}: refused (${why})`);
        if (attempt >= 3) throw new Error(`${spec.name}: three refused attempts; nothing was set yet`);
      }
    }

    // Everything is collected and checked before the first write: a refusal above changes nothing.
    for (const { spec, value } of collected) {
      const r = railway(railwaySetArgs(spec.name, spec.service, opts.environment), dir, value);
      if (!r.ok) throw new Error(`${spec.name} on ${spec.service}: railway refused: ${redact(r.err, values).slice(0, 300)}`);
      console.log(`  set ${spec.service} ${spec.name}`);
    }
    const kekId = collected.find((c) => c.spec.name === "TB_KEK_ID")?.value;
    for (const l of stripeModeNotes(collected)) console.log(l);
    console.log('done. Nothing was deployed. Tell the cutover lead: "secrets are set".');
    if (kekId)
      console.log(`TB_KEK_ID = ${kekId} (not secret). Copy TB_KEK from the Railway dashboard into Vaultwarden now; write the id in ops/ROTATION-LOG.md.`);
  } finally {
    values.length = 0;
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(`prod-secrets: FAIL: ${(e as Error).message}`);
    process.exit(1);
  });
}
