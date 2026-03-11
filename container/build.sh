#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
DOCKERFILE="Dockerfile"
TAG="latest"

# Parse arguments: --bench selects Dockerfile.bench, anything else is the image tag
for arg in "$@"; do
    case "$arg" in
        --bench) DOCKERFILE="Dockerfile.bench"; TAG="bench" ;;
        *) TAG="$arg" ;;
    esac
done

CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"
echo "Dockerfile: ${DOCKERFILE}"

${CONTAINER_RUNTIME} build -f "$DOCKERFILE" -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
