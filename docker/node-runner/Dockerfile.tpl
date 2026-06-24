ARG BASE_IMAGE=node:20-bookworm-slim
FROM ${BASE_IMAGE}

ARG APT_MIRROR=
ARG APT_SECURITY_MIRROR=
ARG APT_ENABLE_BACKPORTS=0

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=Asia/Shanghai

RUN if [ -n "$APT_MIRROR" ]; then \
      set -eu; \
      . /etc/os-release; \
      codename="${VERSION_CODENAME:-}"; \
      if [ -z "$codename" ]; then \
        echo "Unable to determine Debian codename from /etc/os-release" >&2; \
        exit 1; \
      fi; \
      mirror="${APT_MIRROR%/}"; \
      security_mirror="${APT_SECURITY_MIRROR:-${mirror}-security}"; \
      security_mirror="${security_mirror%/}"; \
      components="main contrib non-free"; \
      case "$codename" in \
        bookworm|trixie|forky|duke) components="$components non-free-firmware" ;; \
      esac; \
      rm -f /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; \
      { \
        echo "deb ${mirror} ${codename} ${components}"; \
        echo "deb ${mirror} ${codename}-updates ${components}"; \
        echo "deb ${security_mirror} ${codename}-security ${components}"; \
        if [ "${APT_ENABLE_BACKPORTS}" = "1" ]; then \
          echo "deb ${mirror} ${codename}-backports ${components}"; \
        fi; \
      } > /etc/apt/sources.list; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       bash \
       ca-certificates \
       git \
       curl \
       tzdata \
       python3 \
       make \
       g++ \
    && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
    && echo "$TZ" > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*

COPY certs/ /tmp/ci-certs/
RUN if [ -f /tmp/ci-certs/custom-ca.crt ]; then \
      cp /tmp/ci-certs/custom-ca.crt /usr/local/share/ca-certificates/custom-ca.crt; \
      update-ca-certificates; \
    fi \
    && rm -rf /tmp/ci-certs

COPY ci-entrypoint.sh /usr/local/bin/ci-entrypoint
RUN chmod +x /usr/local/bin/ci-entrypoint

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/ci-entrypoint"]
