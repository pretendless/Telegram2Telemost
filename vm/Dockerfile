# Browser for a Yandex / Telemost login. Build from the repo root:
#   docker build -f vm/Dockerfile -t tg2tm-browser .
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=ru_RU.UTF-8 \
    LC_ALL=ru_RU.UTF-8 \
    DISPLAY=:99 \
    CHROME_BIN=/usr/bin/chromium \
    SESSION_DIR=/var/lib/tg2tm/sessions \
    PROFILE_DIR=/tmp/tg2tm-profiles \
    DEVTOOLS=http://127.0.0.1:9222

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      xvfb \
      x11vnc \
      novnc \
      websockify \
      unzip \
      curl \
      ca-certificates \
      fonts-liberation \
      fonts-dejavu-core \
      fonts-noto-color-emoji \
      locales \
      procps \
    && sed -i 's/^# *\(ru_RU.UTF-8 UTF-8\)/\1/' /etc/locale.gen \
    && locale-gen ru_RU.UTF-8 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/tg2tm/sessions /opt/tg2tm/logs \
    && chmod 777 /var/lib/tg2tm/sessions

WORKDIR /opt/tg2tm

COPY scripts/chrome_cdp.mjs scripts/telemost_upload.mjs scripts/telemost_links.mjs scripts/admin_status.mjs scripts/
COPY vm/ vm/
COPY config/settings.json config/settings.json

# packs/ and logs/ are mounted by the workflow when that checkout has them.
# They are not copied here, so this image builds on a branch that has no sticker catalog.
RUN mkdir -p packs logs && chmod 755 vm/start.sh

EXPOSE 6080

ENTRYPOINT ["bash", "/opt/tg2tm/vm/start.sh"]
