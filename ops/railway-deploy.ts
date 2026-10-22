// Deploy an opt2 service in Railway project "opt2" from its GitHub repo (public, or private via the gh login, C154) at a pushed commit (C32).
//   node ops/railway-deploy.ts --service <name> --repo opt2-tealbrick-<x> --sha <40-hex> [--dockerfile <path>] [--root <dir>] [--environment <name>]
// - --environment: Railway environment name in project opt2 (default `production` = dev; `live` = PROD in test mode, C187).
// - refuses a SHA that is not on GitHub (must be pushed); records the SHA in the deployment.
// - uses the Railway CLI login of the operator (~/.railway/config.json); prints no variable values.
import { spawnSync } from "node:child_process";
import { railwayToken } from "./railway-token.ts";

const PROJECT = "15297ce5-0283-4901-a408-9c802e6ac53a"; // Railway project "opt2"
const DEV_ENVIRONMENT = "2a09b7be-6d8e-4981-a2b1-20bc7922fca5"; // production (= dev)
/** C206: the opt2 repos live in the Tealbrick org; every deploy (re)sets the Railway source to Tealbrick/<repo>. Railway builds a
 *  private org repo through its GitHub app, which must be installed on the Tealbrick org with access to that repo. */
const OWNER = "Tealbrick";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const service = arg("--service");
const repo = arg("--repo");
const sha = arg("--sha");
const dockerfile = arg("--dockerfile");
const root = arg("--root");
const envName = arg("--environment") ?? "production";
if (!service || !repo || !/^opt2-tealbrick-[a-z0-9-]+$/.test(repo) || !sha || !/^[0-9a-f]{40}$/.test(sha))
  throw new Error("usage: --service <name> --repo opt2-tealbrick-<x> --sha <40-hex> [--dockerfile <path>] [--root <dir>]");

railwayToken(); // fail fast when not logged in; every request reads the current (refreshed) token

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: { authorization: `Bearer ${railwayToken()}`, "content-type": "application/json", "user-agent": "opt2-platform-deploy" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || body.errors?.length) throw new Error(`Railway API: ${body.errors?.map((e) => e.message).join("; ") ?? res.status}`);
  return body.data as T;
}

// C154: portal-core becomes private. An anonymous check sees only public repos; for a private repo the check runs through the
// operator's own `gh` login (the token stays inside gh, nothing is printed). Railway itself builds a private repo through its
// GitHub app, which must have access to that repo.
function ghSees(apiPath: string): boolean {
  return spawnSync("gh", ["api", "--silent", apiPath], { stdio: "ignore" }).status === 0;
}
const commit = await fetch(`https://api.github.com/repos/${OWNER}/${repo}/commits/${sha}`, { headers: { accept: "application/vnd.github+json" } });
if (!commit.ok && !ghSees(`repos/${OWNER}/${repo}/commits/${sha}`))
  throw new Error(`${repo}@${sha} is not on GitHub (HTTP ${commit.status}, also not visible to your gh login); push it first`);
if (dockerfile) {
  const df = await fetch(`https://raw.githubusercontent.com/${OWNER}/${repo}/${sha}/${dockerfile}`);
  if (!df.ok && !ghSees(`repos/${OWNER}/${repo}/contents/${dockerfile}?ref=${sha}`)) throw new Error(`${dockerfile} not found at ${repo}@${sha}`);
}

const proj = await gql<{ project: { services: { edges: { node: { id: string; name: string } }[] } } }>(
  "query($id:String!){ project(id:$id){ services{ edges{ node{ id name } } } } }",
  { id: PROJECT },
);
const svc = proj.project.services.edges.map((e) => e.node).find((n) => n.name === service);
if (!svc) throw new Error(`service ${service} not in project opt2 (ask Platform to create it)`);
const envs = await gql<{ project: { environments: { edges: { node: { id: string; name: string } }[] } } }>(
  "query($id:String!){ project(id:$id){ environments{ edges{ node{ id name } } } } }",
  { id: PROJECT },
);
const ENVIRONMENT = envs.project.environments.edges.map((e) => e.node).find((n) => n.name === envName)?.id;
if (!ENVIRONMENT) throw new Error(`environment ${envName} not in project opt2`);
if (envName === "production" && ENVIRONMENT !== DEV_ENVIRONMENT) throw new Error("environment production has an unexpected id; stop and check");

if (dockerfile) {
  await gql("mutation($i:VariableUpsertInput!){ variableUpsert(input:$i) }", {
    i: { projectId: PROJECT, environmentId: ENVIRONMENT, serviceId: svc.id, name: "RAILWAY_DOCKERFILE_PATH", value: dockerfile, skipDeploys: true },
  });
}
await gql("mutation($s:String!,$e:String!,$i:ServiceInstanceUpdateInput!){ serviceInstanceUpdate(serviceId:$s, environmentId:$e, input:$i) }", {
  s: svc.id,
  e: ENVIRONMENT,
  i: { source: { repo: `${OWNER}/${repo}` }, ...(root ? { rootDirectory: root } : {}) },
});
const dep = await gql<{ serviceInstanceDeployV2: string }>(
  "mutation($s:String!,$e:String!,$c:String!){ serviceInstanceDeployV2(serviceId:$s, environmentId:$e, commitSha:$c) }",
  {
    s: svc.id,
    e: ENVIRONMENT,
    c: sha,
  },
);
console.log(`deploy ${service} [${envName}] <- ${OWNER}/${repo}@${sha}${dockerfile ? ` (${dockerfile})` : ""}: deployment ${dep.serviceInstanceDeployV2}`);
