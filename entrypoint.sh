#!/bin/bash
set -euo pipefail

RADIUS_SKILLS_DIR="${RADIUS_SKILLS_DIR:-/data/.openclaw/external-skills/radius-skills}"
RADIUS_SKILLS_BOOTSTRAP_FROM_IMAGE="${RADIUS_SKILLS_BOOTSTRAP_FROM_IMAGE:-true}"
RADIUS_SKILLS_IMAGE_SOURCE="${RADIUS_SKILLS_IMAGE_SOURCE:-/app/vendor/radius-skills}"

mkdir -p /data
chown -R openclaw:openclaw /data
chmod 700 /data

if [ ! -d /data/.linuxbrew ]; then
  cp -a /home/linuxbrew/.linuxbrew /data/.linuxbrew
fi

rm -rf /home/linuxbrew/.linuxbrew
ln -sfn /data/.linuxbrew /home/linuxbrew/.linuxbrew

mkdir -p "$(dirname "$RADIUS_SKILLS_DIR")"
if [ ! -f "$RADIUS_SKILLS_DIR/.git/HEAD" ]; then
  if [ "$RADIUS_SKILLS_BOOTSTRAP_FROM_IMAGE" = "true" ] && [ -d "$RADIUS_SKILLS_IMAGE_SOURCE" ]; then
    echo "[bootstrap] Bootstrapping Radius skills from image snapshot into $RADIUS_SKILLS_DIR"
    rm -rf "$RADIUS_SKILLS_DIR"
    cp -a "$RADIUS_SKILLS_IMAGE_SOURCE" "$RADIUS_SKILLS_DIR"
  else
    echo "[bootstrap] Radius skills source not available or bootstrap disabled; creating empty dir: $RADIUS_SKILLS_DIR"
    mkdir -p "$RADIUS_SKILLS_DIR"
  fi
fi

if [ -d "$RADIUS_SKILLS_DIR" ]; then
  echo "[bootstrap] Radius skills source: $RADIUS_SKILLS_DIR"
  SKILL_COUNT=$(find "$RADIUS_SKILLS_DIR" -name SKILL.md | wc -l | tr -d ' ')
  echo "[bootstrap] Radius vendored SKILL.md count: ${SKILL_COUNT:-0}"
fi

chown -R openclaw:openclaw "$RADIUS_SKILLS_DIR" || true

exec gosu openclaw env \
  RADIUS_SKILLS_DIR="$RADIUS_SKILLS_DIR" \
  RADIUS_SKILLS_BOOTSTRAP_FROM_IMAGE="$RADIUS_SKILLS_BOOTSTRAP_FROM_IMAGE" \
  RADIUS_SKILLS_IMAGE_SOURCE="$RADIUS_SKILLS_IMAGE_SOURCE" \
  node src/server.js
