# =============================================================================
# OriginFlow document processing worker — production Dockerfile
# =============================================================================
#
# Single container, three processes (managed by supervisord):
#   1. clamd       — ClamAV daemon, listens on 127.0.0.1:3310
#   2. freshclam   — ClamAV signature DB updater, runs on schedule
#   3. worker      — Deno process, LISTENs on Postgres + dispatches handlers
#
# The container's healthcheck probes the Deno worker. If the worker is
# alive, it's by extension exercising clamd via the AV handler.
#
# Memory floor: 1 GB. ClamAV's signature DB is ~700 MB resident.
# Smaller instances WILL OOM-kill clamd at random.
# =============================================================================

# Stage 1 — pull the Deno binary from the official image.
FROM denoland/deno:bin-1.46.3 AS deno-bin

# Stage 2 — runtime image.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

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

COPY --from=deno-bin /deno /usr/local/bin/deno
RUN chmod +x /usr/local/bin/deno

# -----------------------------------------------------------------------------
# Configure ClamAV
# -----------------------------------------------------------------------------
# Switch clamd to TCP socket on 127.0.0.1:3310, run in foreground.
# Disable the default Unix socket so the worker can only reach clamd
# via TCP (clearer ops story than juggling socket permissions).
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

# Initial signature DB download. Bakes ~250 MB into the image but
# saves 30-60s on cold start and avoids hammering Cisco mirrors on
# every deploy.
RUN freshclam --foreground --no-warnings || true

# -----------------------------------------------------------------------------
# Application code — FLAT layout
# -----------------------------------------------------------------------------
# All .ts files are siblings in /app. No src/ subdirectory.
# -----------------------------------------------------------------------------
WORKDIR /app

COPY deno.json /app/deno.json
COPY *.ts      /app/

# Pre-cache Deno dependencies so cold start doesn't fetch them.
RUN deno cache --node-modules-dir=auto /app/main.ts

COPY supervisord.conf /etc/supervisor/conf.d/originflow.conf

# -----------------------------------------------------------------------------
# Healthcheck
# -----------------------------------------------------------------------------
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/health > /dev/null || exit 1

EXPOSE 8080

# tini handles PID 1 zombie reaping. Without it, abandoned freshclam
# subprocess corpses can accumulate over weeks.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/supervisord.conf"]
