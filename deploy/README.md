# Deployment

Homeward deploys to the same EC2 instance as orange-story (ap-southeast-2) behind nginx at
https://production.khalidsyfullah.com. There is no SSH and no open deploy port. It takes over the
site slot orange-story used: same app directory (`/var/www/orange`), same pm2 ecosystem file (port
3000) and the same nginx proxy, so nothing on the server changes.

## Flow

1. Push or merge to `main`, or run **Deploy** by hand from the Actions tab.
2. `deploy.yml` runs CI (lint, typecheck, build). If CI fails, nothing is deployed.
3. It assumes the AWS role `orange-github-deploy` through GitHub OIDC (no stored keys).
4. It sends `deploy/homeward-deploy.sh` to the instance over AWS Systems Manager and runs it as `ubuntu`.
5. The script checks out the commit into `/var/www/orange/releases/<timestamp>`, refuses to go on if
   the real frames are missing, builds, flips `/var/www/orange/current`, reloads pm2 and health-checks
   the page and a frame manifest. A failed health check restores the previous release. The newest 5
   releases are kept.
6. A last smoke test requests the public page, a frame manifest (it must say `"placeholder": false`),
   a frame and a sound file.

Pull requests run CI only.

## The art is in git

`public/frames/` (about 52 MB) and `art/source/audio/` (about 1.3 MB) are committed so the server can
build from git. After changing a clip, run `npm run art:import`, commit `public/frames`, and push.
Frame folders are never rewritten in place by the deploy: a folder keeps its name, so rename a clip's
folder if browsers hold on to old frames (they are cached as immutable for a year).

## One-time setup

- AWS: the role `orange-github-deploy` must trust this repo as well as orange-story. The new
  `deploy/iam/trust-policy.json` lists all four subject claims (the plain and id forms for each repo):

      aws login
      aws iam update-assume-role-policy --role-name orange-github-deploy \
        --policy-document file://deploy/iam/trust-policy.json

  `permissions-policy.json` is unchanged (one instance, `AWS-RunShellScript`).
- GitHub: the first run creates the `production` environment. Under Settings > Environments >
  `production`, restrict deployment branches to `main`.

## Orange-story shares the slot

orange-story's own Deploy workflow writes to the same directory and the same pm2 app. Whichever repo
pushed to `main` last is what is live. To keep Homeward up, disable orange-story's Deploy workflow
(or point it at another directory and port).

## Rollback

Re-run **Deploy** on an older commit, or on the server:

    cd /var/www/orange && ls -1dt releases/*
    ln -sfn "$PWD/releases/<timestamp>" current.tmp && mv -Tf current.tmp current
    pm2 startOrReload ecosystem.config.cjs --update-env

The orange-story release that was live before the first Homeward deploy is one of those folders until
it is pruned (after five newer deploys).
