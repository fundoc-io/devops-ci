ARG BASE_IMAGE=node:20-bookworm-slim
FROM ${BASE_IMAGE}

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=Asia/Shanghai

RUN apt-get update \
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
