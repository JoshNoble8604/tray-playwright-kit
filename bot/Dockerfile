# Microsoft's own Playwright image, pinned to the SAME version as package.json.
#
# The pin is load-bearing in both directions: the image ships browsers built for
# one Playwright release, and a mismatch fails at launch with "Executable doesn't
# exist" — which reads like a broken install and is a version skew. Bump both
# lines together or not at all.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

# Dependencies first, so an automation edit does not re-resolve the tree.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY src/ ./src/
COPY automations/ ./automations/

# Stamped into every result. A failing job that cannot be tied to an image is a
# failing job you get to debug twice.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA

# Screenshots and downloads land here. Mount a volume to keep them past the
# container's life — they are the audit trail for anything irreversible.
ENV ARTIFACT_DIR=/artifacts
RUN mkdir -p /artifacts && chown pwuser:pwuser /artifacts
VOLUME ["/artifacts"]

# The image provides this non-root user. A browser rendering hostile HTML should
# not be doing it as root.
USER pwuser

# No healthcheck on a port, because the bot listens on nothing. Liveness is
# whether it is still claiming — visible in the Tray execution log.
CMD ["node", "src/runner.mjs"]
