#!/usr/bin/env bash
# Deploy the fetch forwarder to the TrueNAS box as the `tracked-fetch-proxy`
# Custom App.
#
#   scripts/nas-fetch-proxy-deploy/deploy.sh [--set KEY=VALUE ...] [--unset KEY ...] [--no-start]
#
# Account credentials: source .1001tl-accounts.env (gitignored) and pass each
# pair with --set; see README "Home proxy".
#
# Steps: copy index.mjs + lib + Dockerfile + package.json to the app's build
# dir, `docker build` a fresh image tagged with package.json's version, patch
# the app's compose config in the TrueNAS middleware (new image tag plus any
# `--set` env upserts), and (re)start the app. Needs `ssh $NAS_HOST` with
# passwordless sudo (default host: mnmserver).
#
# The compose config is read from and written back to `midclt call
# app.config/app.update` — the docker-compose.yml on disk is only a reference.
set -euo pipefail
# Git-for-Windows ssh/scp are native binaries: MSYS would rewrite POSIX-looking
# values such as COOKIE_DIR=/data into C:/Program Files/Git/data on the way
# through. Keep every argument verbatim.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

HOST=${NAS_HOST:-mnmserver}
APP=tracked-fetch-proxy
DEST=/mnt/alpha/apps/$APP/$APP
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
# grep/sed rather than node: on Windows git-bash, node does not understand /c/... paths.
VERSION=$(grep -m1 '"version"' "$HERE/package.json" | sed -E 's/.*"version": *"([^"]+)".*/\1/')
IMAGE="$APP:$VERSION"

SETS=()
UNSETS=()
START=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --set) SETS+=("$2"); shift 2 ;;
    --unset) UNSETS+=("$2"); shift 2 ;;
    --no-start) START=0; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

STAGE="/tmp/$APP-deploy-$$"
echo "==> staging files on $HOST:$STAGE"
ssh "$HOST" "mkdir -p '$STAGE'"
scp -q "$ROOT/scripts/nas-fetch-proxy.mjs" "$HOST:$STAGE/index.mjs"
scp -q "$ROOT/scripts/nas-fetch-proxy-lib.mjs" "$HERE/Dockerfile" "$HERE/package.json" "$HERE/.dockerignore" "$HOST:$STAGE/"

echo "==> installing into $DEST and building $IMAGE"
ssh "$HOST" "sudo install -o apps -g apps -m 644 '$STAGE'/index.mjs '$STAGE'/nas-fetch-proxy-lib.mjs '$STAGE'/Dockerfile '$STAGE'/package.json '$STAGE'/.dockerignore '$DEST'/ \
  && rm -rf '$STAGE' \
  && sudo docker build -q -t '$IMAGE' '$DEST' >/dev/null && echo built $IMAGE"

echo "==> patching app compose (image=$IMAGE${SETS[*]:+, set: ${SETS[*]%%=*}}${UNSETS[*]:+, unset: ${UNSETS[*]}})"
# The env upserts travel as a JSON array so values with commas/newlines survive.
SETS_JSON=$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "${SETS[@]}")
UNSETS_JSON=$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "${UNSETS[@]}")
ssh "$HOST" "sudo midclt call app.config '$APP' | python3 -c '
import json, sys
cfg = json.load(sys.stdin)
image = sys.argv[1]
sets = json.loads(sys.argv[2])
unsets = json.loads(sys.argv[3])
svc = cfg[\"services\"][\"$APP\"]
svc[\"image\"] = image
env = svc.get(\"environment\") or []
env = [e for e in env if e.split(\"=\", 1)[0] not in unsets]
for kv in sets:
    k = kv.split(\"=\", 1)[0]
    env = [e for e in env if not e.startswith(k + \"=\")]
    env.append(kv)
svc[\"environment\"] = env
print(json.dumps({\"custom_compose_config\": cfg}))
' '$IMAGE' '$SETS_JSON' '$UNSETS_JSON' > /tmp/$APP-update.json \
  && sudo midclt call app.update '$APP' \"\$(cat /tmp/$APP-update.json)\" >/dev/null && rm -f /tmp/$APP-update.json && echo compose updated"

if [[ $START -eq 1 ]]; then
  echo "==> starting app (app.redeploy when already running, so the new image/env is picked up)"
  ssh "$HOST" "state=\$(sudo midclt call app.query '[[\"name\",\"=\",\"$APP\"]]' | python3 -c 'import json,sys; a=json.load(sys.stdin); print(a[0][\"state\"] if a else \"MISSING\")'); \
    echo \"state before: \$state\"; \
    if [ \"\$state\" != RUNNING ]; then sudo midclt call app.start '$APP' >/dev/null; else sudo midclt call -j app.redeploy '$APP' >/dev/null; fi; \
    for i in \$(seq 1 30); do sleep 2; h=\$(sudo docker inspect --format '{{.State.Health.Status}}' $APP 2>/dev/null || echo starting); [ \"\$h\" = healthy ] && break; done; \
    echo \"container health: \$h\"; \
    sudo docker exec $APP wget -qO- http://127.0.0.1:8088/health; echo"
fi
echo "==> done"
