# =============================================================================
# OriginFlow document processing worker — production Dockerfile
# =============================================================================
#
# Single container, three processes (managed by supervisord):
#
#   1. clamd       — ClamAV daemon, listens on 127.0.0.1:3310
#   2. freshclam   — ClamAV signature database updater, runs on schedule
#   3. worker      — Deno process, LISTENs on Postgres + dispatches handlers
#
# The container's healthcheck probes the Deno worker. If the worker is
# alive, it's by extension exercising clamd via the AV handler; if clamd
# is down, the worker reports unhealthy and Fly.io replaces the VM.
#
# Memory floor: 1 GB. ClamAV's signature DB is ~700 MB resident. Smaller
# instances WILL OOM-kill clamd at random and produce confusing
# "connection refused" errors in the worker logs.
# =============================================================================

# Stage 1 — pull the Deno binary from the official image. Smaller than
# installing Deno from a curl|sh in the runtime stage and lets us pin
# the exact version.
FROM denoland/deno:bin-1.46.3 AS deno-bin

# Stage 2 — runtime image. Ubuntu 24.04 because that's where the
# ClamAV packages are well-maintained; Alpine's clamav has historically
# been a step behind on signature format support.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

# Install ClamAV + supervisord + utilities. We don't pin Ubuntu
# package versions — they get security updates we want — but we DO
# pin the Deno binary above for reproducibility of the worker code
# path.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      clamav \
      clamav-daemon \
      clamav-freshclam \
      supervisor \
      ca-certificates \
      curl \
      tini \
 && rm -rf /var/lib/apt/lists/*

# Pull Deno binary into the runtime image.
COPY --from=deno-bin /deno /usr/local/bin/deno
RUN chmod +x /usr/local/bin/deno

# -----------------------------------------------------------------------------
# Configure ClamAV
# -----------------------------------------------------------------------------
# clamd.conf — switch to TCP socket on 127.0.0.1:3310, run in
# foreground (supervisord requires that).
#
# freshclam.conf — also foreground; runs as a long-lived process
# that updates the signature DB every few hours.
#
# We comment out the LocalSocket line because the default config
# enables both UNIX and TCP sockets and we want clarity that the worker
# connects via TCP only.
# -----------------------------------------------------------------------------
RUN sed -i \
      -e 's|^#TCPSocket .*|TCPSocket 3310|' \
      -e 's|^#TCPAddr .*|TCPAddr 127.0.0.1|' \
      -e 's|^Foreground .*|Foreground true|' \
      -e 's|^#Foreground .*|Foreground true|' \
      -e 's|^LocalSocket |#LocalSocket |' \
      /etc/clamav/clamd.conf \
 && sed -i \
      -e 's|^Foreground .*|Foreground true|' \
      -e 's|^#Foreground .*|Foreground true|' \
      /etc/clamav/freshclam.conf

# Initial signature database download. Bakes ~250 MB of signatures
# into the image but saves 30-60s on cold start. Cisco's mirrors
# rate-limit aggressively; baking avoids hammering them on every
# deploy.
#
# `|| true` because freshclam sometimes returns non-zero on partial
# success (some optional databases unavailable) which we don't care
# about — clamd starts fine without them.
RUN freshclam --foreground --no-warnings || true

# -----------------------------------------------------------------------------
# Application code
# -----------------------------------------------------------------------------
WORKDIR /app

# Copy deno.json first to leverage Docker layer caching of dependency
# resolution.
COPY deno.json /app/deno.json
COPY src       /app/src

# Pre-cache Deno dependencies. Without this the first NOTIFY would
# stall waiting for npm:postgres and npm:@anthropic-ai/sdk to download.
RUN deno cache --node-modules-dir=auto /app/src/main.ts

# Supervisord config
COPY supervisord.conf /etc/supervisor/conf.d/originflow.conf

# -----------------------------------------------------------------------------
# Healthcheck
# -----------------------------------------------------------------------------
# Fly.io has its own HTTP-based health check (see fly.toml); this
# HEALTHCHECK is for any other orchestrator we run this image on
# (local docker-compose, ECS, Kubernetes, etc).
#
# start-period=60s gives ClamAV time to load signatures before we
# start counting failures. After startup the worker's /health
# responds in single-digit ms.
# -----------------------------------------------------------------------------
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/health > /dev/null || exit 1

EXPOSE 8080

# tini handles PID 1 zombie reaping (supervisord doesn't do this
# reliably across all child types). Without tini, abandoned freshclam
# subprocess corpses can accumulate over weeks.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/supervisord.conf"]
