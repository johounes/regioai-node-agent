#!/bin/bash
# Petals-Server: hostet einen Teil der Modell-Blöcke und tritt dem privaten
# Swarm über die vom Bootstrap geschriebene Multiaddr bei.
set -e

echo "⏳ Warte auf /swarm/peers.txt ..."
for i in $(seq 1 120); do
  [ -s /swarm/peers.txt ] && break
  sleep 2
done
if [ ! -s /swarm/peers.txt ]; then
  echo "❌ Kein DHT-Peer gefunden – Bootstrap nicht bereit?"
  exit 1
fi
PEERS="$(cat /swarm/peers.txt)"
echo "🔗 initial_peers: $PEERS"

ARGS="--initial_peers $PEERS --device cuda --identity_path /swarm/server.id"
if [ -n "$NUM_BLOCKS" ]; then
  ARGS="$ARGS --num_blocks $NUM_BLOCKS"
fi

echo "🧩 Starte Petals-Server für $CAG_SWARM_MODEL ($ARGS)"
exec python -m petals.cli.run_server "$CAG_SWARM_MODEL" $ARGS
