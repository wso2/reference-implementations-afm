---
# ============================================================================
# AGENT DETAILS - All fields OPTIONAL
# ============================================================================
spec_version: "0.4.0"                    # AFM specification version
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
  # Webhook Interface (WebSub-style event notifications)
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

  # Platform Chat Interface (third-party chat platforms: Slack, Google Chat, etc.)
  # mode: notification = ack immediately, run agent in background
  # mode: request      = run agent synchronously, return result in HTTP response
  # mode: polling      = pull platform updates in a background loop
  # Each platform supports a subset of modes; see platform docs.
  - type: platformchat
    platform: gchat                      # REQUIRED: gchat, slack, telegram, ...
    mode: request                        # gchat supports: notification | request
    prompt: |
      [${http:payload.type}] Reply to ${http:payload.message.text}
    platform_config:
      project_number: "${env:GCHAT_PROJECT_NUMBER}"
    signature:                           # Only meaningful in 'request' mode
      output:
        type: object
        properties:
          text:
            type: string
    exposure:
      http:
        path: "/gchat"                   # REQUIRED

  # Telegram (webhook delivery).
  - type: platformchat
    platform: telegram
    mode: notification                   # telegram supports: notification | polling
    prompt: |
      Reply to ${http:payload.message.text}
    platform_config:
      # Pass the same value to Telegram's setWebhook `secret_token`
      # parameter. Telegram echoes it in the
      # X-Telegram-Bot-Api-Secret-Token header on every delivery.
      secret_token: "${env:TELEGRAM_SECRET_TOKEN}"
    exposure:
      http:
        path: "/telegram"

  # Telegram (polling — getUpdates long-poll).
  # Use this instead of the notification block above when you can't expose
  # a public webhook URL. Telegram disallows both at once for the same bot.
  - type: platformchat
    platform: telegram
    mode: polling
    prompt: |
      Reply to ${http:payload.message.text}
    platform_config:
      bot_token: "${env:TELEGRAM_BOT_TOKEN}"
    polling:
      interval: 1                        # seconds between getUpdates calls
      timeout: 30                        # Telegram long-poll timeout (max 50)

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
