// Engine adapter contract for the own-server host agent (S1, C308) and the types the compose+Caddy reference adapter implements.
//
// WHY THIS FILE EXISTS: REDTEAM M2 says "behind our adapter" is only an exit path if the CONTRACT, not Openship, defines the features and a
// second, tiny engine runs the same conformance suite on every host-agent release. The Openship adapter (host agent, cli repo) and the
// compose+Caddy fixture here implement the same `EngineAdapter`; `conformance.ts` is the suite both must pass.
//
// The service shape is the CLOSED `HostServiceSpec` of the S1-0 draft (coordination/roadmap/S1-0-CONTRACT-DRAFT.md section 4). When the
// spec package 0.1.58 ships these types, delete the copies below and import them (one mechanism per concern, L1); the validator in
// schema.ts stays as the reference of what "closed" means until the spec has its JSON schema.

/** `^tb-[a-z0-9-]{1,40}$`: single label, created by the agent, never a name that could fall through to upstream DNS. */
export type ServiceName = string;

export interface HostServiceSpec {
  serviceName: ServiceName;
  release: { product: string; releaseId: string; image: string /* name@sha256:... */; manifestDigest: string };
  /** names must be declared by that release's manifest runtime.env (policy on the box, not here); public values only */
  env: Record<string, string>;
  /** names; the adapter generates and keeps the values */
  generatedSecrets: string[];
  /** env name -> value taken from another service of the same stack (its env or generated secret `env`) */
  serviceRefs?: Record<string, { serviceName: ServiceName; env: string }>;
  port: number | null;
  /** true only for the bridge */
  publicDomain: boolean;
  /** bridge only (C59): the two public hosts, inside the workspace sub-zone */
  publicHosts?: { main: string; keys: string };
  healthPath: string | null;
  /** named volumes only; no host paths */
  volumes: { name: string; mountPath: string; purpose: "data" | "backup" }[];
  resources: { cpu?: number; memoryMb?: number; volumeGb?: number } | null;
}

/** One workspace on one box: ONE stack (own network, own volumes), all services of that workspace. */
export interface StackSpec {
  workspace: string;
  /** the workspace sub-zone the public hosts must be inside (e.g. ws.example.net) */
  zone: string;
  services: HostServiceSpec[];
  /** loopback port for each public service; chosen and remembered by the agent, a default is derived when absent */
  hostPorts?: Record<ServiceName, number>;
}

/** Everything the adapter would send to its engine, as text. Conformance greps it, so it must be COMPLETE (no hidden side channel). */
export interface Rendered {
  engine: string;
  documents: { name: string; text: string }[];
}

export type ServiceState = "running" | "starting" | "stopped" | "failed";
export interface ServiceStatus {
  serviceName: ServiceName;
  state: ServiceState;
  image: string;
  health: "ok" | "failing" | "none";
  restarts: number;
}

/** What the host agent needs from an engine. Openship and the compose+Caddy fixture both implement it. */
export interface EngineAdapter {
  readonly name: string;
  /** PURE: validates the stack against the closed schema and returns every document the engine would receive. Throws SpecRefusal. */
  render(stack: StackSpec): Rendered;
  /** Idempotent: make the engine run exactly this stack (stopped services stay stopped). */
  apply(stack: StackSpec): Promise<void>;
  /** Stops the service and KEEPS its volumes (S1 has no delete-data path). */
  stop(workspace: string, serviceName: ServiceName): Promise<void>;
  status(workspace: string): Promise<ServiceStatus[]>;
  /** Exact origins the bridge may call (value of TB_OWN_INFRA_ORIGINS): `http://<service>:<port>` for the stack's non-public services with a port. */
  originsFor(stack: StackSpec): string[];
  /** Names of the data volumes of the workspace (what a stop must leave alone). */
  volumesOf(workspace: string): Promise<string[]>;
  /** PURE: the network and volume names this stack would create in the engine. Two workspaces must never share one (REDTEAM isolation). */
  scopeOf(stack: StackSpec): { networks: string[]; volumes: string[] };
}

export type RefusalCode =
  | "forbidden_field"
  | "unknown_field"
  | "bad_field"
  | "bad_name"
  | "image_not_digest"
  | "host_path"
  | "public_not_bridge"
  | "bad_host"
  | "bad_ref"
  | "duplicate";

/** Thrown by render/validation for anything outside the closed schema. The host agent maps it to a report code. */
export class SpecRefusal extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode, message: string) {
    super(message);
    this.name = "SpecRefusal";
    this.code = code;
  }
}
