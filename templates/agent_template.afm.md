---
# ============================================================================
# AGENT DETAILS - All fields OPTIONAL
# ============================================================================
spec_version: "0.3.0"                    # AFM specification version
name: "Agent Name"                       # Human-readable agent name
description: "Brief description of the agent's purpose and functionality"
version: "1.0.0"                         # Semantic version (MAJOR.MINOR.PATCH)

# Single author format (use 'authors' for multiple)
author: "Name <email@example.com>"

# Multiple authors (takes precedence over 'author' if both exist)
authors:
  - "Jane Smith <jane@example.com>"
  - "John Doe <john@example.com>"

provider:
  name: "Organization Name"
  url: "https://organization.com"

icon_url: "https://example.com/icons/agent-icon.png"
license: "MIT"

# ============================================================================
# AGENT MODEL - All fields OPTIONAL
# ============================================================================
model:
  provider: "openai"                     # Model provider (openai, anthropic, etc.)
  name: "gpt-4-turbo"                    # Model identifier
  url: "https://api.openai.com/v1/chat/completions"
  authentication:
    type: "api-key"
    api_key: "${env:MODEL_API_KEY}"

# ============================================================================
# AGENT EXECUTION - OPTIONAL
# ============================================================================
max_iterations: 50                       # Maximum iterations per agent run

# ============================================================================
# AGENT INTERFACES - OPTIONAL (defaults to consolechat)
# ============================================================================
interfaces:
  # Console Chat Interface
  - type: consolechat

  # Web Chat Interface
  - type: webchat
    exposure:
      http:
        path: "/chat"                    # Default: /chat for webchat

  # Webhook Interface
  - type: webhook
    prompt: |
      Analyze the following event that was received.

      Event Details:
      - Type: ${http:payload.event}
      - Timestamp: ${http:payload.timestamp}
      - Source: ${http:payload.source}
      - Header: ${http:header.X-Event-Type}

      Payload:
      ${http:payload}
    subscription:
      protocol: "websub"                 # REQUIRED
      hub: "https://example.com/websub-hub"
      topic: "https://example.com/events/agent"
      callback: "${env:CALLBACK_URL}"
      secret: "${env:WEBHOOK_SECRET}"
      authentication:
        type: "bearer"
        token: "${env:WEBHOOK_AUTH_TOKEN}"
    exposure:
      http:
        path: "/webhook"                 # Default: /webhook for webhook

# ============================================================================
# TOOLS - OPTIONAL
# ============================================================================
tools:
  mcp:
    # MCP Server with bearer authentication
    - name: "github_mcp_server"
      transport:
        type: "http"                     # Only "http" is currently supported
        url: "${env:GITHUB_MCP_URL}"
        authentication:
          type: "bearer"
          token: "${env:GITHUB_OAUTH_TOKEN}"
      tool_filter:
        allow:                           # Whitelist of tools
          - "issues.create"
          - "repos.list"
        deny:                            # Blacklist (applied after allow)
          - "repos.delete"

    # MCP Server with basic authentication
    - name: "database_server"
      transport:
        type: "http"
        url: "${env:DATABASE_MCP_URL}"
        authentication:
          type: "basic"
          username: "${env:DB_USERNAME}"
          password: "${env:DB_PASSWORD}"
      tool_filter:
        deny:
          - "delete"
          - "drop_table"

    # MCP Server without authentication
    - name: "public_tools"
      transport:
        type: "http"
        url: "https://public-mcp.example.com"
---

# Role

You are [describe the agent's purpose and responsibilities here]. This section
defines what the agent does and the context in which it operates. This content
typically forms the opening context of the system prompt.

# Instructions

[Provide directives that shape the agent's behavior, capabilities, and
operational guidelines here. This section contains the core logic and rules
that govern how the agent processes inputs and generates outputs.]
