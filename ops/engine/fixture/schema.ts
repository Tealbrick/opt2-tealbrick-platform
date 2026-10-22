// Reference validator of the CLOSED service schema (S1-0 draft section 4, REDTEAM B2/B3). Anything that is not listed is refused, and
// the fields that would let a service reach the host or another container are refused BY NAME so a log line says why.
// This is the contract an engine adapter must enforce before it generates anything. Pure, no I/O.
import { type HostServiceSpec, SpecRefusal, type StackSpec } from "./contract.ts";

const ALLOWED = [
  "serviceName",
  "release",
  "env",
  "generatedSecrets",
  "serviceRefs",
  "port",
  "publicDomain",
  "publicHosts",
  "healthPath",
  "volumes",
  "resources",
];
/** Compose/Openship fields that give a container the host or a neighbour. Named so a refusal is explicit (B3: network_mode: container:<edge>). */
export const FORBIDDEN_FIELDS = [
  "network_mode",
  "networkMode",
  "pid",
  "ipc",
  "uts",
  "userns_mode",
  "cgroup",
  "cgroup_parent",
  "privileged",
  "cap_add",
  "cap_drop",
  "devices",
  "device_cgroup_rules",
  "extra_hosts",
  "user",
  "sysctls",
  "entrypoint",
  "command",
  "cmd",
  "labels",
  "security_opt",
  "ports",
  "expose",
  "tmpfs",
  "mounts",
  "bind",
  "binds",
  "build",
  "depends_on",
  "networks",
  "dns",
  "hostname",
  "domainname",
  "mac_address",
  "init",
  "runtime",
  "volumes_from",
  "links",
  "external_links",
  "env_file",
  "configs",
  "secrets",
  "deploy",
  "restart",
  "healthcheck",
  "pull_policy",
  "stdin_open",
  "tty",
  "working_dir",
] as const;

export const SERVICE_NAME_RE = /^tb-[a-z0-9-]{1,40}$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._/-]{0,200}@sha256:[0-9a-f]{64}$/;
const VOLUME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
/** Mount points inside the container that would shadow system or runtime paths. */
const BAD_MOUNT = /^\/(proc|sys|dev|run|var\/run|etc|boot|root|bin|sbin|usr|lib|lib64)(\/|$)/;

const bad = (message: string): never => {
  throw new SpecRefusal("bad_field", message);
};
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Validates one service. Returns it typed; throws SpecRefusal. */
export function validateServiceSpec(raw: unknown): HostServiceSpec {
  if (!isObj(raw)) return bad("service must be an object");
  for (const k of Object.keys(raw)) {
    if ((FORBIDDEN_FIELDS as readonly string[]).includes(k))
      throw new SpecRefusal("forbidden_field", `${k} is not allowed (the closed schema never carries host, namespace or privilege fields)`);
    if (!ALLOWED.includes(k)) throw new SpecRefusal("unknown_field", `unknown field ${k}`);
  }
  const name = raw.serviceName;
  if (typeof name !== "string" || !SERVICE_NAME_RE.test(name)) throw new SpecRefusal("bad_name", `serviceName must match ${SERVICE_NAME_RE}`);
  const rel = raw.release;
  if (!isObj(rel) || Object.keys(rel).sort().join(",") !== "image,manifestDigest,product,releaseId")
    return bad(`${name}: release must be exactly {product, releaseId, image, manifestDigest}`);
  if (typeof rel.image !== "string" || !IMAGE_RE.test(rel.image))
    throw new SpecRefusal("image_not_digest", `${name}: image must be <name>@sha256:<64 hex> (no tag)`);
  for (const k of ["product", "releaseId", "manifestDigest"]) if (typeof rel[k] !== "string" || !rel[k]) return bad(`${name}: release.${k}`);
  if (!isObj(raw.env)) return bad(`${name}: env must be an object`);
  for (const [k, v] of Object.entries(raw.env)) {
    if (!ENV_NAME_RE.test(k)) return bad(`${name}: env name ${k}`);
    if (typeof v !== "string" || v.length > 4096 || v.includes("\0") || v.includes("\n"))
      return bad(`${name}: env ${k} must be a single-line string of at most 4096 characters`);
  }
  if (!Array.isArray(raw.generatedSecrets) || raw.generatedSecrets.some((s) => typeof s !== "string" || !ENV_NAME_RE.test(s)))
    return bad(`${name}: generatedSecrets must be env names`);
  const secrets = raw.generatedSecrets as string[];
  if (new Set(secrets).size !== secrets.length) throw new SpecRefusal("duplicate", `${name}: generatedSecrets repeat`);
  for (const s of secrets) if (s in raw.env) throw new SpecRefusal("duplicate", `${name}: ${s} is both an env value and a generated secret`);
  if (raw.serviceRefs !== undefined) {
    if (!isObj(raw.serviceRefs)) return bad(`${name}: serviceRefs`);
    for (const [k, v] of Object.entries(raw.serviceRefs)) {
      if (!ENV_NAME_RE.test(k) || !isObj(v) || Object.keys(v).sort().join(",") !== "env,serviceName")
        throw new SpecRefusal("bad_ref", `${name}: serviceRefs.${k} must be {serviceName, env}`);
      if (typeof v.serviceName !== "string" || !SERVICE_NAME_RE.test(v.serviceName) || typeof v.env !== "string" || !ENV_NAME_RE.test(v.env))
        throw new SpecRefusal("bad_ref", `${name}: serviceRefs.${k}`);
    }
  }
  if (raw.port !== null && !(Number.isInteger(raw.port) && (raw.port as number) >= 1 && (raw.port as number) <= 65535))
    return bad(`${name}: port must be null or 1..65535`);
  if (typeof raw.publicDomain !== "boolean") return bad(`${name}: publicDomain must be a boolean`);
  if (raw.publicDomain) {
    if (rel.product !== "bridge") throw new SpecRefusal("public_not_bridge", `${name}: only the bridge may have a public domain`);
    const h = raw.publicHosts;
    if (
      !isObj(h) ||
      Object.keys(h).sort().join(",") !== "keys,main" ||
      typeof h.main !== "string" ||
      typeof h.keys !== "string" ||
      !HOST_RE.test(h.main) ||
      !HOST_RE.test(h.keys) ||
      h.main === h.keys
    )
      throw new SpecRefusal("bad_host", `${name}: publicHosts must be two different DNS names {main, keys}`);
    if (raw.port === null) return bad(`${name}: a public service needs a port`);
  } else if (raw.publicHosts !== undefined) throw new SpecRefusal("bad_host", `${name}: publicHosts only with publicDomain`);
  if (raw.healthPath !== null && !(typeof raw.healthPath === "string" && /^\/[A-Za-z0-9._~/-]{0,200}$/.test(raw.healthPath) && !raw.healthPath.includes("..")))
    return bad(`${name}: healthPath`);
  if (!Array.isArray(raw.volumes) || raw.volumes.length > 8) return bad(`${name}: volumes (at most 8)`);
  const mounts = new Set<string>();
  const vnames = new Set<string>();
  for (const v of raw.volumes as unknown[]) {
    if (!isObj(v) || Object.keys(v).sort().join(",") !== "mountPath,name,purpose") return bad(`${name}: a volume must be exactly {name, mountPath, purpose}`);
    if (typeof v.name !== "string" || !VOLUME_RE.test(v.name))
      throw new SpecRefusal("host_path", `${name}: volume name ${String(v.name)} must be a plain name (named volumes only, no host path)`);
    if (typeof v.mountPath !== "string" || !/^\/[A-Za-z0-9._/-]{1,200}$/.test(v.mountPath) || v.mountPath.includes("..") || BAD_MOUNT.test(v.mountPath))
      return bad(`${name}: mountPath ${String(v.mountPath)}`);
    if (v.purpose !== "data" && v.purpose !== "backup") return bad(`${name}: volume purpose`);
    if (mounts.has(v.mountPath) || vnames.has(v.name)) throw new SpecRefusal("duplicate", `${name}: volume name or mountPath repeats`);
    mounts.add(v.mountPath);
    vnames.add(v.name);
  }
  if (raw.resources !== null) {
    const r = raw.resources;
    if (!isObj(r) || Object.keys(r).some((k) => !["cpu", "memoryMb", "volumeGb"].includes(k))) return bad(`${name}: resources`);
    if (r.cpu !== undefined && !(typeof r.cpu === "number" && r.cpu >= 0.1 && r.cpu <= 16)) return bad(`${name}: resources.cpu`);
    if (r.memoryMb !== undefined && !(Number.isInteger(r.memoryMb) && (r.memoryMb as number) >= 64 && (r.memoryMb as number) <= 65536))
      return bad(`${name}: resources.memoryMb`);
    if (r.volumeGb !== undefined && !(Number.isInteger(r.volumeGb) && (r.volumeGb as number) >= 1 && (r.volumeGb as number) <= 2048))
      return bad(`${name}: resources.volumeGb`);
  }
  return raw as unknown as HostServiceSpec;
}

/** Validates the whole stack: every service, unique names, refs that point inside the stack, public hosts inside the zone, one public service. */
export function validateStack(stack: StackSpec): StackSpec {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(stack.workspace)) throw new SpecRefusal("bad_name", `workspace ${stack.workspace}`);
  if (!HOST_RE.test(stack.zone)) throw new SpecRefusal("bad_host", `zone ${stack.zone}`);
  const services = stack.services.map((s) => validateServiceSpec(s));
  const names = new Set<string>();
  for (const s of services) {
    if (names.has(s.serviceName)) throw new SpecRefusal("duplicate", `service ${s.serviceName} appears twice`);
    names.add(s.serviceName);
  }
  for (const s of services) {
    for (const [k, ref] of Object.entries(s.serviceRefs ?? {})) {
      const target = services.find((x) => x.serviceName === ref.serviceName);
      if (!target) throw new SpecRefusal("bad_ref", `${s.serviceName}: ${k} points at ${ref.serviceName}, which is not in this stack`);
      if (!(ref.env in target.env) && !target.generatedSecrets.includes(ref.env))
        throw new SpecRefusal("bad_ref", `${s.serviceName}: ${k} points at ${ref.serviceName}.${ref.env}, which that service does not define`);
    }
    if (s.publicDomain) {
      const h = s.publicHosts as { main: string; keys: string };
      for (const host of [h.main, h.keys])
        if (!host.endsWith(`.${stack.zone}`)) throw new SpecRefusal("bad_host", `${s.serviceName}: ${host} is outside the workspace zone ${stack.zone}`);
    }
  }
  if (services.filter((s) => s.publicDomain).length > 1) throw new SpecRefusal("public_not_bridge", "more than one public service in a stack");
  return { ...stack, services };
}
