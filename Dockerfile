FROM node:24-bookworm-slim

# bubblewrap (bwrap) is required by the sandboxed-bash plugin
RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap \
    && rm -rf /var/lib/apt/lists/*
