# Debian-slim (glibc) statt Alpine (musl) – nötig, damit das vom NVIDIA
# Container Toolkit eingehängte nvidia-smi für echte GPU-Telemetrie läuft.
FROM node:22-slim

WORKDIR /app
COPY package.json ./
COPY agent.mjs ./
COPY setup.html ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "agent.mjs"]
