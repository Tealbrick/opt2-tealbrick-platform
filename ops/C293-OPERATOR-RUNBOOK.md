# C293 operator runbook: deploy plugin, rollout test, first DEV deploy

For the operator (the Coordinator). Follow it as written, in order. Each command has its EXPECTED output.
If the output differs: STOP. Do not retry blindly. Do part (e) and report.

Where: a checkout of the platform repo on the branch `feat/c293-website-autodeploy-setup` (or `main` after platform PR 54 is merged).
Called `$PLATFORM` below. Needs: Docker with buildx (`docker buildx version` prints a version) and Node 24.

```sh
cd "$PLATFORM" && git status -sb | head -1
```

Expected: `## feat/c293-website-autodeploy-setup...origin/feat/c293-website-autodeploy-setup` (or `## main...origin/main`).

Prerequisite for (a): Martin made the Forgejo write token and saved it (`ops/C293-MARTIN-STEPS.md`, step c2, step 14).

```sh
ls -l ~/.config/opt2-tealbrick/forge-packages-token
```

Expected: one line that starts with `-rw-------`. If the file is missing or the mode differs, STOP: Martin does step c2.

## (a) Publish the plugin image

1. Dry run. It builds nothing and calls nothing.

```sh
node ops/site-deploy-plugin-publish.ts
```

Expected output (the token path shows your home folder), exit 0:

```
image: forge.polygonface.com/polygonface/tb-site-deploy:1.0.0
platforms: linux/amd64,linux/arm64
build context: ops/site-deploy-plugin (Dockerfile, site-deploy.ts, VERSION)
registry: forge.polygonface.com
token file: /Users/<you>/.config/opt2-tealbrick/forge-packages-token (write:package; read at --push only)
--push: (1) refuse if the tag already exists in the registry, (2) docker login, (3) docker buildx build --push, (4) docker logout, (5) print the digest
dry run: nothing was built, nothing was pushed
```

2. Push. `<forgejo-login>` is Martin's Forgejo login name (the owner of the write token). Ask Martin if you do not know it.

```sh
node ops/site-deploy-plugin-publish.ts --push --user <forgejo-login>
```

Expected output (build progress is not shown), exit 0. The digest is different each time you build:

```
pushed forge.polygonface.com/polygonface/tb-site-deploy:1.0.0
digest sha256:<64 hex characters>
image reference: forge.polygonface.com/polygonface/tb-site-deploy:1.0.0@sha256:<64 hex characters>
```

Write the digest in the C293 ledger line. Tell Martin: "the image is published, digest <first 12 characters>". Martin then runs step d.

3. Reuse check. Run the same command again.

```sh
node ops/site-deploy-plugin-publish.ts --push --user <forgejo-login>
```

Expected, exit 1, nothing is built or pushed:

```
site-deploy-plugin-publish: FAIL: forge.polygonface.com/polygonface/tb-site-deploy:1.0.0 already exists in the registry. A tag is never reused: raise ops/site-deploy-plugin/VERSION, then update the website workflow and the secret filters. Nothing was pushed.
```

If step 3 pushes anything, STOP and report at once: the reuse rule is broken.

## (b) Rollout test (mandatory before S2-b is called closed)

Goal: prove that a writer's branch cannot read the two secrets, and that the plugin refuses a commit that is not on `main`.
Do it only after Martin finished step d (the setup script printed `done`) and the website pull request is merged.

1. Write down where the two deploy branches are now. You compare them in step 7.

```sh
gh api repos/Tealbrick/opt2-tealbrick-website/git/ref/heads/site-dev --jq .object.sha
gh api repos/Tealbrick/opt2-tealbrick-website/git/ref/heads/site-live --jq .object.sha
```

Expected: two lines of 40 hex characters. `site-live` starts with `af814db`.

Make the test branch in a clone of the website repo. The branch name is exactly `c293-rollout-test`.

```sh
cd <your clone of Tealbrick/opt2-tealbrick-website>
git fetch origin
git switch -c c293-rollout-test origin/main
```

Expected: `Switched to a new branch 'c293-rollout-test'`.

2. Write the test workflow. It prints only `present` or `absent`, never a value. Copy it exactly.

```sh
cat > .woodpecker/rollout-test.yaml <<'YAML'
# C293 rollout test. Do not merge. Prints only present/absent, never a value.
labels:
  platform: linux/amd64
when:
  - event: push
    branch: c293-rollout-test
steps:
  - name: secrets-in-command-step
    image: node:24.21.0-bookworm@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0
    environment:
      T:
        from_secret: site_deploy_token
      K:
        from_secret: site_deploy_key
    commands:
      - 'if [ -n "$T" ]; then echo "site_deploy_token: present"; else echo "site_deploy_token: absent"; fi'
      - 'if [ -n "$K" ]; then echo "site_deploy_key: present"; else echo "site_deploy_key: absent"; fi'
      - 'if [ -n "$PLUGIN_TOKEN" ]; then echo "PLUGIN_TOKEN: present"; else echo "PLUGIN_TOKEN: absent"; fi'
      - 'if [ -n "$PLUGIN_DEPLOY_KEY" ]; then echo "PLUGIN_DEPLOY_KEY: present"; else echo "PLUGIN_DEPLOY_KEY: absent"; fi'
  - name: plugin-on-branch
    image: forge.polygonface.com/polygonface/tb-site-deploy:1.0.0
    settings:
      mode: dev
      token:
        from_secret: site_deploy_token
      deploy_key:
        from_secret: site_deploy_key
YAML
```

3. Push the branch.

```sh
git add .woodpecker/rollout-test.yaml
git commit -m "test: C293 rollout test (do not merge)"
git push -u origin c293-rollout-test
git rev-parse HEAD
```

Expected: the push ends with `* [new branch]      c293-rollout-test -> c293-rollout-test`. Write down the commit SHA the last command prints.

4. Read the result. Open Woodpecker, the repo `Tealbrick/opt2-tealbrick-website`, Pipelines. Open the newest pipeline (branch `c293-rollout-test`).
   You can also run `node ops/wp-failed.ts Tealbrick/opt2-tealbrick-website <the commit SHA>` from `$PLATFORM`. It shows the log of the failed step only.

5. Expected result, step `secrets-in-command-step` (open its log). All four lines say `absent`:

```
site_deploy_token: absent
site_deploy_key: absent
PLUGIN_TOKEN: absent
PLUGIN_DEPLOY_KEY: absent
```

   Also acceptable: Woodpecker refuses the whole pipeline and says the secret cannot be used with this image. That also means "not readable". Write down the message.
   FAIL: any line says `present`. Then the secrets are readable by a writer's branch. STOP, tell Martin to delete both Woodpecker secrets at once, and report.

6. Expected result, step `plugin-on-branch` (open its log). The step ends red (exit code 1). The log shows:

```
tb-site-deploy 1.0.0
FAILED: commit <12 hex characters> is not on main (main is behind of it): refused
Rollback: merge a revert commit on main, then tag a new site version. ...
```

   The words `is not on main` must be there. The 12 hex characters are the first 12 of the SHA from step 3.
   FAIL: the log says `site-dev:` with an arrow, or `DEV serves`. Then the plugin pushed from a branch. STOP and report. Tell Martin to pause the site ruleset and check `site-dev`.

7. Check that nothing moved. Both commands must print the same commits that you wrote down in step 1:

```sh
gh api repos/Tealbrick/opt2-tealbrick-website/git/ref/heads/site-dev --jq .object.sha
gh api repos/Tealbrick/opt2-tealbrick-website/git/ref/heads/site-live --jq .object.sha
```

8. Remove the test branch. A `git push --delete` removes a branch on GitHub. It does not remove files.

```sh
git switch main
git push origin --delete c293-rollout-test
git branch -D c293-rollout-test
```

Expected: `- [deleted]         c293-rollout-test`, then `Deleted branch c293-rollout-test`.
The file `.woodpecker/rollout-test.yaml` stays only on the deleted branch. It is not on `main`.

If steps 5 and 6 both match: tell the Coordinator "rollout test passed". Only then S2-b is closed. Add the date and the pipeline number to the decision log.

## (c) Both agents pull the image

The plugin image must run on BOTH Woodpecker agents. One agent is arm64, the other amd64; the image is built for amd64 and arm64.
The agents' `hostname` labels are internal names and are NOT written in this public repo: take them from the private
coordination notes (coordination/specs/C293-WEBSITE-SELF-SERVICE.md, "Operator notes") and set `AGENT_1` and `AGENT_2` first.
Do this on a new branch the same way as (b), with one more file per agent.

1. Make the branch `c293-agent-test` from `origin/main`, as in (b) step 1.
2. Write two files. Each runs the plugin on one named agent. The plugin refuses (not on main), but its first log line proves the image ran there.

```sh
for A in "$AGENT_1" "$AGENT_2"; do
cat > .woodpecker/agent-test-$A.yaml <<YAML
# C293 agent test. Do not merge.
labels:
  hostname: $A
when:
  - event: push
    branch: c293-agent-test
steps:
  - name: plugin-on-$A
    image: forge.polygonface.com/polygonface/tb-site-deploy:1.0.0
    settings:
      mode: dev
      token:
        from_secret: site_deploy_token
      deploy_key:
        from_secret: site_deploy_key
YAML
done
git add .woodpecker && git commit -m "test: C293 agent pull test (do not merge)" && git push -u origin c293-agent-test
```

3. Open the newest pipeline of the branch `c293-agent-test` in Woodpecker. It has two workflows: `agent-test-$AGENT_1` and `agent-test-$AGENT_2`.
4. Expected for each workflow: the step log starts with the image pull (or no pull line if the image is cached) and then shows

```
tb-site-deploy 1.0.0
FAILED: commit <12 hex characters> is not on main ...
```

   The line `tb-site-deploy 1.0.0` on BOTH workflows proves both agents pulled and ran the image.
5. If a workflow stays "pending": the agent label `hostname` has another value. Open Woodpecker, Admin, Agents. Read the agent names and labels. Change `hostname:` and push again. Do not guess.
6. If a log says `pull access denied` or `unauthorized`: the registry credential is wrong. STOP and report (do part e).
7. Remove the branch as in (b) step 8 (use `c293-agent-test`).

## (d) The first real DEV deploy

The website pull request is merged. The merge makes a push to `main`. The workflow `site-deploy` runs after `ci`.

1. Open Woodpecker, the repo, Pipelines, the newest pipeline of branch `main`. The workflow `site-deploy`, step `deploy-dev` shows:

```
tb-site-deploy 1.0.0
site-dev: <12 hex> -> <12 hex> (fast-forward push)
waiting for https://website-production-66a1.up.railway.app/version.txt = <12 hex> (now: ...)
DEV serves <12 hex> (https://website-production-66a1.up.railway.app/version.txt)
DEV smoke / : ok (HTTP 200)
DEV smoke /robots.txt: ok (HTTP 200)
DEV smoke /.well-known/security.txt: ok (HTTP 200, Contact: line present)
DEV deploy done: <12 hex>
```

   If the branch was already at the commit, the second line says `site-dev is already at <12 hex>`. This is fine.
   Railway needs a few minutes to build. The step waits up to 15 minutes.
2. Read the stamp. Compare it with `main`:

```sh
curl -s https://website-production-66a1.up.railway.app/version.txt
gh api repos/Tealbrick/opt2-tealbrick-website/git/ref/heads/main --jq .object.sha
```

Expected: both print the same 40 characters.
3. Then Martin does step f (the DEV rollback test). The first LIVE tag comes only after it.

## (e) If any step fails

1. Stop. Do not run the command again. Do not change a secret, a branch or a setting to make it pass.
2. Copy the exact output of the failed command (without any token) into the report.
3. Check that nothing moved: run the two `gh api` commands of (b) step 1 and compare with what you wrote down.
4. If a secret printed `present` in (b), or the plugin pushed from a branch: tell Martin at once to delete both Woodpecker secrets `site_deploy_key` and `site_deploy_token`.
5. Report to the Coordinator with: the part and step number, the command, the output, and the pipeline number.
