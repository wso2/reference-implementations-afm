# Stage 1: Builder
FROM python:3.13-alpine AS builder

# Install uv for fast dependency management
COPY --from=ghcr.io/astral-sh/uv:0.10.0 /uv /uvx /bin/

# Set environment variables for uv and optimization
ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy
ENV UV_NO_DEV=1

# Change the working directory to the `app` directory
WORKDIR /app

# Install dependencies first (for better caching)
COPY uv.lock pyproject.toml README.md ./
COPY packages/afm-core/pyproject.toml packages/afm-core/README.md packages/afm-core/
COPY packages/afm-langchain/pyproject.toml packages/afm-langchain/README.md packages/afm-langchain/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-workspace --no-editable

# Copy workspace packages source
COPY packages/afm-core/src/ packages/afm-core/src/
COPY packages/afm-langchain/src/ packages/afm-langchain/src/

# Install only the packages we need (not afm-cli)
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-editable --package afm-core --package afm-langchain

# Stage 2: Final image
# VARIANT=full installs Node.js, npm (npx), git, and uv/uvx for MCP server support.
# VARIANT=slim ships only Python + .venv.
FROM python:3.13-alpine
ARG VARIANT=full

# Validate VARIANT early so typos fail loudly instead of silently producing a slim build.
RUN if [ "$VARIANT" != "full" ] && [ "$VARIANT" != "slim" ]; then \
        echo "ERROR: VARIANT must be 'full' or 'slim', got: '$VARIANT'" >&2; \
        exit 1; \
    fi

RUN if [ "$VARIANT" = "full" ]; then \
        apk add --no-cache nodejs npm git; \
    fi

# Install uv and uvx for Python-based MCP server support (full variant only)
# Use bind mounts so the uv binaries are never written into any image layer for slim builds.
RUN --mount=type=bind,from=ghcr.io/astral-sh/uv:0.10.0,source=/uv,target=/tmp/uv \
    --mount=type=bind,from=ghcr.io/astral-sh/uv:0.10.0,source=/uvx,target=/tmp/uvx \
    if [ "$VARIANT" = "full" ]; then \
        cp /tmp/uv /tmp/uvx /bin/; \
    fi

# Set working directory
WORKDIR /app

# Copy the virtual environment from the builder stage
COPY --from=builder /app/.venv /app/.venv

# Set environment variables
ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1
# Signal to the AFM update checker that it's running inside a container.
# This suppresses package-manager upgrade commands in update notifications
# since users should update by rebuilding or pulling the container image.
ENV AFM_RUNTIME=docker

# Expose default port for web interfaces
EXPOSE 8000

# Entry point to run the afm CLI
ENTRYPOINT ["afm"]
CMD ["--help"]
