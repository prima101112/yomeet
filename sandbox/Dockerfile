# YoMeet's Claude Code sandbox: the only host folder it ever sees is the workspace mount.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates git python3 ripgrep jq \
    && rm -rf /var/lib/apt/lists/*
ARG CLAUDE_CODE_VERSION=2.1.327
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force
ENV HOME=/home/yomeet CLAUDE_CONFIG_DIR=/home/yomeet/.claude DISABLE_AUTOUPDATER=1
RUN mkdir -p /home/yomeet/.claude && chmod -R 777 /home/yomeet
CMD ["sleep", "infinity"]
