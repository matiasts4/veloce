#!/bin/sh
echo "==================================================="
echo "  Veloce Linux GUI Test Runner (Docker + WSLg)"
echo "==================================================="

IMAGE_NAME="veloce-linux-gui"
# Use the Dockerfile we just fixed
DOCKERFILE="tests/docker/Dockerfile.linux_gui"

# Cache dir (Use Windows path mounted in WSL)
CACHE_DIR="/mnt/d/veloce_cache"
mkdir -p "$CACHE_DIR"

echo "[1/3] Building Docker Image..."
# We need to build from the repo root
cd "$(dirname "$0")/../.." || exit
docker build -t "$IMAGE_NAME" -f "$DOCKERFILE" .

# Launch with WSLg Socket
IMAGE_NAME="veloce-linux-gui"
CACHE_DIR="/mnt/d/veloce_cache"

# Fallbacks for WSLg if variables are missing
export DISPLAY=${DISPLAY:-:0}
export WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-wayland-0}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/1000}
export PULSE_SERVER=${PULSE_SERVER:-unix:/mnt/wslg/PulseServer}

echo "Using DISPLAY=$DISPLAY"
echo "Using WAYLAND_DISPLAY=$WAYLAND_DISPLAY"

docker run --rm -i \
  --privileged \
  --net=host \
  -v /tmp/.X11-unix:/tmp/.X11-unix \
  -v /mnt/wslg:/mnt/wslg \
  -e DISPLAY=$DISPLAY \
  -e WAYLAND_DISPLAY=$WAYLAND_DISPLAY \
  -e XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR \
  -e PULSE_SERVER=$PULSE_SERVER \
  -v "$CACHE_DIR":/root/.cache/huggingface \
  "$IMAGE_NAME" npm run tauri dev
