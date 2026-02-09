# Stage 1: Builder
FROM python:3.11-slim-bookworm AS builder

# Install uv for fast dependency management
COPY --from=ghcr.io/astral-sh/uv:0.10.0 /uv /uvx /bin/

# Set environment variables for uv and optimization
ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy
ENV UV_NO_DEV=1

# Change the working directory to the `app` directory
WORKDIR /app

# Install dependencies first (for better caching)
COPY uv.lock pyproject.toml ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-editable

# Copy the source code into the builder stage
COPY src/ ./src/
COPY README.md ./

# Sync the project (installs the current project into the venv)
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-editable

# Stage 2: Final image
FROM python:3.11-slim-bookworm

# Set working directory
WORKDIR /app

# Copy the virtual environment from the builder stage
COPY --from=builder /app/.venv /app/.venv

# Set environment variables
ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1

# Expose default port for web interfaces
EXPOSE 8000

# Entry point to run the afm CLI
ENTRYPOINT ["afm"]
CMD ["--help"]
