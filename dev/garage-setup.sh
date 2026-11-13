#!/usr/bin/env sh
# Starts a single-node Garage (S3-compatible) in Docker and creates the bucket + key.
# Prints S3_ACCESS_KEY / S3_SECRET_KEY lines you can eval.
set -e
NAME=${GARAGE_NAME:-crush-garage}
BUCKET=${S3_BUCKET:-submissions}
DIR=$(cd "$(dirname "$0")" && pwd)
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p 3900:3900 -p 3903:3903 \
  -v "$DIR/garage.toml:/etc/garage.toml:ro" dxflrs/garage:v2.1.0 >/dev/null
g() { docker exec "$NAME" /garage "$@" 2>/dev/null; }
for i in $(seq 1 30); do g status >/dev/null 2>&1 && break; sleep 1; done
NODE=$(g status 2>/dev/null | awk '/^[0-9a-f]{16}/{print $1; exit}')
g layout assign -z dc1 -c 1G "$NODE" >/dev/null
g layout apply --version 1 >/dev/null
g bucket create "$BUCKET" >/dev/null
KEYOUT=$(g key create crush-key)
AK=$(echo "$KEYOUT" | awk '/Key ID/{print $NF}')
SK=$(echo "$KEYOUT" | awk '/Secret key/{print $NF}')
g bucket allow --read --write --owner "$BUCKET" --key crush-key >/dev/null
echo "export S3_ENDPOINT=http://localhost:3900 S3_REGION=garage S3_BUCKET=$BUCKET S3_ACCESS_KEY=$AK S3_SECRET_KEY=$SK S3_FORCE_PATH_STYLE=true"
