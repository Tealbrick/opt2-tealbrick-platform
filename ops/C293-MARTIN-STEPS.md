# C293 steps for Martin: website self-service deploy

Language: ASD-STE100. Each step has one instruction. Do the steps in the order a, c, d, e, b, then merge, then f.
Repo = `Tealbrick/opt2-tealbrick-website`. Platform repo = `Tealbrick/opt2-tealbrick-platform`.

What this gives you: a merge to `main` deploys DEV. A tag `site-vX.Y.Z` on a `main` commit deploys LIVE.
Railway builds from the branches `site-dev` (DEV) and `site-live` (LIVE). No Railway token is used in CI.

WARNING: Do not merge the website pull request before steps a, c, d and e are done. The deploy step fails without them.

WARNING: Do not run `ops/woodpecker-activate.ts` before the platform pull request of this change is merged.
The old version of that script deletes the secret `site_deploy_token`.

## a. Create the two branches on GitHub

WARNING: A different commit on `site-live` deploys that commit to LIVE (tealbrick.com).

1. Open a terminal.
2. Run `gh auth status`. Make sure it shows your admin login.
3. Run `MAIN=$(gh api repos/Tealbrick/opt2-tealbrick-website/git/ref/heads/main --jq .object.sha)`.
4. Run `gh api -X POST repos/Tealbrick/opt2-tealbrick-website/git/refs -f ref=refs/heads/site-dev -f sha="$MAIN"`.
5. Open the Railway LIVE environment, service `website`. Make sure the active deployment shows commit `af814db`.
6. Run `gh api -X POST repos/Tealbrick/opt2-tealbrick-website/git/refs -f ref=refs/heads/site-live -f sha=af814db94c7a94551f73895428732f8bfb6e5dfa`.
   This is the RS-7.6 website commit that LIVE runs now.
7. Run `gh api repos/Tealbrick/opt2-tealbrick-website/git/ref/heads/site-live --jq .object.sha`.
8. Make sure the answer starts with `af814db`.

## c. Create the GitHub token

WARNING: Do not paste the token in a chat, a ticket or a file. Only step d uses it.

1. Open GitHub. Go to Settings, Developer settings, Personal access tokens, Fine-grained tokens.
2. Click "Generate new token".
3. Set the name to `site-deploy`.
4. Set "Resource owner" to `Tealbrick`.
5. Set "Expiration" to a custom date, one year from today.
6. Set "Repository access" to "Only select repositories". Select `opt2-tealbrick-website` only.
7. Open "Repository permissions". Set "Contents" to "Read and write". Leave every other permission as it is.
8. Click "Generate token". Copy the token.
9. If the organisation asks for approval of the token, approve it as an owner.
10. Write the expiry date in `ops/ROTATION-LOG.md` (date only, not the token).

## d. Store the token in Woodpecker

WARNING: The script asks for the token with hidden input. Nothing shows on the screen when you paste.

1. Open a terminal in the platform repo (after its pull request is merged, or on the branch `feat/c293-website-autodeploy-setup`).
2. Run `node ops/website-autodeploy-setup.ts --dry-run`. Read the plan.
3. Run `node ops/website-autodeploy-setup.ts`.
4. Paste the token. Press Enter.
5. Wait for the last line. It must say `done`.
6. Make sure the line "secret names" lists `site_deploy_token`.
7. Close the terminal tab. Clear the clipboard.

If the script says "not in Woodpecker", run `node ops/woodpecker-activate.ts --repo website` and run step d again.

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

## b. Apply the branch protection

WARNING: On the free GitHub plan with a private repo, GitHub refuses branch protection (HTTP 403, checked 2026-10-20).
CODEOWNERS also does not bind then.

1. Open `docs/BRANCH-PROTECTION.md` in the website repo. Read the section "Read this first".
2. Decide: make the repo public, or stay private without protection.
3. If you stay private, stop here. The script guards stay active. Tell the Coordinator.
4. If the repo is public, run the commands in the sections "main" and "site-dev and site-live".
5. Run the two check commands at the end of the file. Make sure `site-live` shows `force: false`.

## Merge the website pull request

1. Open the website pull request "C293". Wait for the check `ci/woodpecker/pr/ci` to turn green.
2. Merge it into `main`.
3. Open Woodpecker. Make sure the workflow `site-deploy` ran after `ci` and the step `deploy-dev` is green.

## f. Test the rollback on DEV

WARNING: Do not tag `site-v1.0.0` (the first LIVE use) before this test passes.

An operator does these steps. Use the DEV address `https://website-production-66a1.up.railway.app`.

1. Open `<DEV address>/version.txt`. Make sure it shows the commit of the merge in step "Merge the website pull request".
2. Open a pull request with one trivial change (for example one word in `README.md`). Merge it.
3. Wait up to 15 minutes. Open `<DEV address>/version.txt`. Make sure it shows the new commit.
4. Open the merged pull request. Click "Revert". Merge the revert pull request.
5. Wait up to 15 minutes. Open `<DEV address>/version.txt`. Make sure it shows the revert commit.
6. Open the DEV site. Make sure the home page loads.
7. Tell the Coordinator: "DEV rollback test passed".

After step 7 the first LIVE deploy is a tag `site-v1.0.0` on `main`. See "Publish the website" in the website `CONTRIBUTING.md`.
