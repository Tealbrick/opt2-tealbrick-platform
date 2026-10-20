# C293 steps for Martin: website self-service deploy

Language: ASD-STE100. Each step has one instruction. Do the steps in this order: a, c, c2, the image publish, d, e, b, the merge, the rollout test, then f.
The image publish and the rollout test are done by an operator. They are in `ops/C293-OPERATOR-RUNBOOK.md`.
Repo = `Tealbrick/opt2-tealbrick-website`. Platform repo = `Tealbrick/opt2-tealbrick-platform`.

What this gives you: a merge to `main` deploys DEV. A tag `site-vX.Y.Z` on a `main` commit deploys LIVE.
Railway builds from the branches `site-dev` (DEV) and `site-live` (LIVE). No Railway token is used in CI.
Woodpecker moves the two branches over SSH with a write deploy key (`site_deploy_key`).
Only a small plugin image (`forge.polygonface.com/polygonface/tb-site-deploy`) can read the key and the token.
A workflow on a writer's branch cannot read them. This closes the residual risk only after the rollout test passed.
The GitHub token (`site_deploy_token`) only writes the release record. It does not move branches.

WARNING: Do not merge the website pull request before steps a, c, c2, the image publish, d and e are done. The deploy step fails without them.

WARNING: Do not run `ops/woodpecker-activate.ts` before the platform pull request of this change is merged.
The old version of that script deletes the secrets `site_deploy_key` and `site_deploy_token`.

WARNING: Anyone with write access to the repo can make the robot deploy LIVE, also around the code-owner review.
Woodpecker gives secrets by event, not by branch. A branch with its own workflow file can use the deploy key and the token.
So the model is: people with write access are trusted publishers, and every LIVE deploy is visible.
Keep the list of people with write access short.

## a. Create the two branches on GitHub

WARNING: A different commit on `site-live` deploys that commit to LIVE (tealbrick.com).

1. Open a terminal in a clone of the website repo.
2. Run `gh auth status`. Make sure it shows your admin login.
3. Run `git fetch origin`.
4. Run `MAIN=$(gh api repos/Tealbrick/opt2-tealbrick-website/git/ref/heads/main --jq .object.sha)`.
5. Run `gh api -X POST repos/Tealbrick/opt2-tealbrick-website/git/refs -f ref=refs/heads/site-dev -f sha="$MAIN"`.
6. Open the Railway LIVE environment, service `website`. Make sure the active deployment shows commit `af814db`.
7. Run `git merge-base --is-ancestor af814db94c7a94551f73895428732f8bfb6e5dfa origin/main && echo YES`.
8. Make sure the answer is `YES`. If there is no answer, stop and ask the Coordinator.
9. Run `gh api -X POST repos/Tealbrick/opt2-tealbrick-website/git/refs -f ref=refs/heads/site-live -f sha=af814db94c7a94551f73895428732f8bfb6e5dfa`.
   This is the RS-7.6 website commit that LIVE runs now.
10. Run `gh api repos/Tealbrick/opt2-tealbrick-website/git/ref/heads/site-live --jq .object.sha`.
11. Make sure the answer starts with `af814db`.

## c. Create the deploy key and the GitHub token

WARNING: Do not paste the private key or the token in a chat, a ticket or a file you keep. Only step d uses them.

WARNING: The repo must have exactly ONE deploy key with write access. A ruleset lets every deploy key move `site-live`.

1. Run `mkdir -p ~/tmp-site-deploy && cd ~/tmp-site-deploy`.
2. Run `ssh-keygen -t ed25519 -N "" -C site-deploy -f ./site_deploy_key`. This makes a private and a public file.
3. Open GitHub. Open the website repo, then Settings, then Deploy keys.
4. Click "Add deploy key". Set the title to `site-deploy`.
5. Paste the content of `site_deploy_key.pub`.
6. Tick "Allow write access". Click "Add key".
7. Run `gh api repos/Tealbrick/opt2-tealbrick-website/keys --jq '.[]|{title,read_only}'`.
8. Make sure exactly one key shows `read_only: false`.
9. Open GitHub. Go to Settings, Developer settings, Personal access tokens, Fine-grained tokens. Click "Generate new token".
10. Set the name to `site-deploy-release`. Set "Resource owner" to `Tealbrick`.
11. Set "Expiration" to a custom date, one year from today.
12. Set "Repository access" to "Only select repositories". Select `opt2-tealbrick-website` only.
13. Open "Repository permissions". Set "Contents" to "Read and write". Leave every other permission as it is.
14. Click "Generate token". Copy the token.
15. If the organisation asks for approval of the token, approve it as an owner.
16. Write the token expiry date in `ops/ROTATION-LOG.md` (date only, not the token).

Optional but recommended: a bot account for the token.
17. Create a GitHub account only for this job. Give it the "Write" role on the website repo. Do not give it "Admin".
18. Create the token in step 9 to 14 with that account. A leaked token then gives write access, not your admin powers.

## c2. Create the two Forgejo tokens

WARNING: Make two separate tokens. The write token never goes into Woodpecker. The read token never goes into a file.

1. Open Forgejo (`https://forge.polygonface.com`). Sign in with your own login.
2. Go to Settings, then Applications. Find "Manage Access Tokens".
3. Set the token name to `site-deploy-publish`.
4. Set the permission "package" to "Read and Write". Leave every other permission at "No access".
5. Click "Generate Token". Copy the token.
6. Run `mkdir -p ~/.config/opt2-tealbrick`.
7. Run `umask 077 && pbpaste > ~/.config/opt2-tealbrick/forge-packages-token`. This writes the token from the clipboard.
8. Run `chmod 600 ~/.config/opt2-tealbrick/forge-packages-token`.
9. Run `ls -l ~/.config/opt2-tealbrick/forge-packages-token`. Make sure the mode shows `-rw-------`.
10. Clear the clipboard.
11. Recommended: use a dedicated Forgejo machine user for the read token. The setup script cannot check the scope of the token.
    A machine user that can only read packages limits the damage if the token leaks.
12. Create the machine user `site-deploy-pull` in Forgejo (Site Administration, User Accounts). Give it read access to the package owner `polygonface`.
13. Sign in as that user. Go to Settings, then Applications. Set the token name to `site-deploy-pull`.
14. Set the permission "package" to "Read". Leave every other permission at "No access".
15. Click "Generate Token". Copy the token. Do not save it in a file. Step d asks for it.
16. If you do not use a machine user, make the token with your own login instead. Then step d asks for your login name.
17. Tell the operator: "the publish token file is ready". The operator publishes the image (runbook, part a).
18. Wait for the operator to report the image digest. Do not start step d before that.

## d. Store the key, the tokens and the registry login in Woodpecker

WARNING: The script asks for the values with hidden input. Nothing shows on the screen when you paste.
The script asks for your Forgejo login name in clear text. This is not a secret.

1. Open a terminal in the platform repo (after its pull request is merged, or on the branch `feat/c293-website-autodeploy-setup`).
2. Run `node ops/website-autodeploy-setup.ts --dry-run`. Read the plan. The image filter must end with `@sha256:` and the digest from the operator.
3. Run `node ops/website-autodeploy-setup.ts`.
4. Run `cat ~/tmp-site-deploy/site_deploy_key` in a second terminal tab. Copy the whole output.
5. Paste it in the first tab. The script stops reading at the last line of the key.
6. Paste the GitHub token. Press Enter.
7. Type the Forgejo login name of the owner of the read token (the machine user). Press Enter.
8. Paste the Forgejo read token from step c2. Press Enter.
9. Wait for the last line. It must say `done`.
10. Make sure the line "secret names" lists `site_deploy_key` and `site_deploy_token`.
11. Make sure the line "secrets" shows the image filter `forge.polygonface.com/polygonface/tb-site-deploy:1.0.0@sha256:` and 64 characters.
12. Make sure the line "registry addresses" lists `forge.polygonface.com`.
13. Delete the two files in `~/tmp-site-deploy` yourself. Delete the folder. Clear the clipboard.
14. Close both terminal tabs.

If the script says "not recorded yet", the operator did not commit `ops/site-deploy-plugin/IMAGE-DIGEST`. Ask the operator.
If the rollout test later shows that Woodpecker does not match the digest, the operator runs step d again with `--image-filter forge.polygonface.com/polygonface/tb-site-deploy:1.0.0`. Then a person who can write to the registry could replace the tag. That is the known residual risk.
If the script says "not in Woodpecker", run `node ops/woodpecker-activate.ts --repo website` and run step d again.
If the script says the Woodpecker URL is not https, correct `WOODPECKER_URL` in `~/.config/opt2-tealbrick/hosts.env`.

## e. Point Railway at the two branches

WARNING: Change LIVE only after `site-live` exists and shows `af814db` (step a).

WARNING: Do not use `ops/railway-deploy.ts` for the service `website` after this change. It resets the Railway source.

1. Open Railway. Open the project `opt2`.
2. Select the environment `production` (DEV). Open the service `website`, then Settings, then Source.
3. Set the branch to `site-dev`.
4. Make sure automatic deployments are on. The setting must not say "Disabled".
5. Select the environment `live`. Open the service `website`, then Settings, then Source.
6. Set the branch to `site-live`.
7. Make sure automatic deployments are on.
8. Open the DEV settings again. Make sure the branch is still `site-dev`.

Railway can start one deployment of the same commit after you change a branch. This is normal.
Railway documentation says the trigger branch is a service setting, and that environments can follow different branches.
Check on screen that the DEV and the LIVE settings are separate. If one change moved the other, stop and tell the Coordinator.

## b. Apply the rulesets

WARNING: On the free GitHub plan with a private repo, GitHub refuses rulesets (HTTP 403, checked 2026-10-20).
Rulesets work on public repos only. CODEOWNERS also does not bind on a private repo.

WARNING: Create the branches `site-dev` and `site-live` (step a) before ruleset 2. Only the deploy key can create them after that.

1. Open `docs/BRANCH-PROTECTION.md` in the website repo. Read the section "Prerequisite: the repo must be public".
2. Decide: make the repo public, or stay private without rulesets.
3. If you stay private, stop here. The guards in the deploy script stay active. Tell the Coordinator.
4. If the repo is public, run the commands of ruleset 1, ruleset 2 and ruleset 3 in that file.
5. Run the five checks at the end of that file.
6. Make sure ruleset 2 lists "Deploy keys" as the only bypass.
7. Read the section "Residual risk". Decide if Teiger212 keeps the "admin" role or gets the "write" role.
   Admins can edit rulesets.

## Merge the website pull request, then the rollout test

1. Open the website pull request "C293". Wait for the check `ci/woodpecker/pr/ci` to turn green.
2. Merge it into `main`.
3. Open Woodpecker. Make sure the workflow `site-deploy` ran after `ci` and the step `deploy-dev` is green.
4. Ask the operator to do the rollout test (`ops/C293-OPERATOR-RUNBOOK.md`, part b and c). Wait for the result.
5. If the test fails, stop. Tell the Coordinator. The residual risk stays open.

## f. Test the rollback on DEV

WARNING: Do not tag `site-v1.0.0` (the first LIVE use) before this test and the rollout test pass.

An operator does these steps. Use the DEV address `https://website-production-66a1.up.railway.app`.

1. Open `<DEV address>/version.txt`. Make sure it shows the commit of the merge in step "Merge the website pull request".
2. Open a pull request with one trivial change (for example one word in `README.md`). Merge it.
3. Wait up to 15 minutes. Open `<DEV address>/version.txt`. Make sure it shows the new commit.
4. Open the merged pull request. Click "Revert". Merge the revert pull request.
5. Wait up to 15 minutes. Open `<DEV address>/version.txt`. Make sure it shows the revert commit.
6. Open the DEV site. Make sure the home page loads.
7. Tell the Coordinator: "DEV rollback test passed".

After step 7 the first LIVE deploy is a tag `site-v1.0.0` on the commit you checked on DEV.
See "Publish the website" in the website `CONTRIBUTING.md`.
