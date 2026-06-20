FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash coder
USER coder
