---
name: docker-deploy
description: Deploy applications using Docker and Docker Compose
paths: ["Dockerfile*", "docker-compose*.yml", "docker-compose*.yaml", ".dockerignore"]
required_environment_variables:
  - name: DOCKER_REGISTRY
    prompt: "Enter your Docker registry URL (e.g., docker.io/username)"
    help: "https://docs.docker.com/docker-hub/repos/"
    required_for: "pushing images to registry"
  - name: DOCKER_REGISTRY_TOKEN
    prompt: "Enter your Docker registry access token"
    help: "https://docs.docker.com/security/for-developers/access-tokens/"
    required_for: "authenticating with registry"
platforms: [macos, linux]
---

# Docker Deployment Guide

This skill helps you deploy applications using Docker and Docker Compose.

## Prerequisites

- Docker installed and running
- Docker Compose (for multi-container apps)
- Registry credentials configured

## Quick Start

1. Build the Docker image:
   ```bash
   docker build -t myapp:latest .
   ```

2. Run the container:
   ```bash
   docker run -p 3000:3000 myapp:latest
   ```

## Docker Compose Deployment

For multi-container applications:

```bash
docker-compose up -d
```

## Registry Operations

Push to registry (requires DOCKER_REGISTRY and DOCKER_REGISTRY_TOKEN):

```bash
docker tag myapp:latest $DOCKER_REGISTRY/myapp:latest
docker push $DOCKER_REGISTRY/myapp:latest
```

## Best Practices

- Use multi-stage builds for smaller images
- Keep sensitive data in environment variables
- Use `.dockerignore` to exclude unnecessary files
- Tag images with version numbers, not just `latest`
