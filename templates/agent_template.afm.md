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
  authentication:                        # Only "bearer" or "api-key" (without header_name)
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
      authentication:                    # Any of the five types, see the MCP examples below
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
    # --------------------------------------------------------------------------
    # HTTP Transport Examples
    # --------------------------------------------------------------------------

    # MCP Server with bearer authentication
    - name: "github_mcp_server"
      transport:
        type: "http"
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

    # MCP Server with JWT authentication (the runtime signs a new JWT for every request)
    - name: "signed_requests_server"
      transport:
        type: "http"
        url: "${env:SIGNED_MCP_URL}"
        authentication:
          type: "jwt"
          issuer: "my-agent"
          audience: "https://mcp.example.com"
          signing_key: "${env:JWT_HMAC_SECRET}"   # HS*: the secret; RS*: path to an unencrypted PEM key file
          algorithm: "HS256"                      # Optional, RS256 by default
          expiry_seconds: 300                     # Optional, 300 by default

    # API key and OAuth2 authentication use the same schema. Both interpreters support them on an MCP server
    # (the Ballerina interpreter speaks MCP protocol version 2025-03-26 to such a server).
    #
    # - name: "api_key_server"
    #   transport:
    #     type: "http"
    #     url: "${env:API_KEY_MCP_URL}"
    #     authentication:
    #       type: "api-key"
    #       api_key: "${env:MCP_API_KEY}"
    #       header_name: "X-API-Key"                # Optional, "Authorization" by default
    #
    # - name: "oauth2_server"
    #   transport:
    #     type: "http"
    #     url: "${env:OAUTH2_MCP_URL}"
    #     authentication:
    #       type: "oauth2"
    #       grant_type: "client_credentials"
    #       token_url: "https://identity.example.com/oauth/token"
    #       client_id: "${env:OAUTH_CLIENT_ID}"
    #       client_secret: "${env:OAUTH_CLIENT_SECRET}"
    #       scopes: ["tools"]
    #       # token_endpoint_auth_method: "client_secret_post"   # Optional, "client_secret_basic" by default
    #       # resource: "https://mcp.example.com"                # Optional, the MCP server URL by default
    #
    # - name: "oauth2_jwt_bearer_server"            # OAuth2 JWT bearer grant (RFC 7523)
    #   transport:
    #     type: "http"
    #     url: "${env:OAUTH2_JWT_MCP_URL}"
    #     authentication:
    #       type: "oauth2"
    #       grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer"
    #       token_url: "https://identity.example.com/oauth/token"
    #       token_endpoint_auth_method: "none"      # No client authentication
    #       assertion_signing:
    #         issuer: "my-agent"
    #         subject: "my-service-account"          # Required: the "sub" claim of the assertion
    #         audience: "https://identity.example.com/oauth/token"
    #         signing_key: "./keys/private.pem"      # Relative to this file
    #         custom_claims:
    #           scope: "api:read"

    # MCP Server without authentication
    - name: "public_tools"
      transport:
        type: "http"
        url: "https://public-mcp.example.com"

    # --------------------------------------------------------------------------
    # stdio Transport Examples
    # --------------------------------------------------------------------------
    # NOTE: stdio transport is currently only supported in the LangChain-based
    # interpreter for AFM

    # MCP Server via npx package
    - name: "filesystem_server"
      transport:
        type: "stdio"
        command: "npx"
        args:
          - "-y"
          - "@modelcontextprotocol/server-filesystem"
          - "${env:ALLOWED_DIRECTORY}"
      tool_filter:
        deny:
          - "write_file"
          - "edit_file"

    # MCP Server via Python script with environment variables
    - name: "local_db_tool"
      transport:
        type: "stdio"
        command: "python"
        args:
          - "server.py"
        env:
          DB_PATH: "./data.db"
          API_KEY: "${env:LOCAL_DB_API_KEY}"
      tool_filter:
        allow:
          - "query"
          - "search"
# ============================================================================
# SKILLS - OPTIONAL (Agent Skills format: https://agentskills.io)
# ============================================================================
skills:
  # Local skills directory (or a directory that may contain multiple skill subdirectories)
  - type: "local"
    path: "./skills"
---

# Role

You are [describe the agent's purpose and responsibilities here]. This section
defines what the agent does and the context in which it operates. This content
typically forms the opening context of the system prompt.

# Instructions

[Provide directives that shape the agent's behavior, capabilities, and
operational guidelines here. This section contains the core logic and rules
that govern how the agent processes inputs and generates outputs.]
