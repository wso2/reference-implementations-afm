---
spec_version: '0.3.0'
name: "TelegramTestAgent"
description: "A test agent for telegram platformchat notification mode."
author: "Copilot"
version: "0.1.0"
interfaces:
  - type: platformchat
    platform: telegram
    mode: notification
    prompt: "Telegram message: ${http:payload.message.text}"
    platform_config:
      secret_token: "test-telegram-secret"
max_iterations: 5
model:
  provider: "wso2"
  url: "http://localhost:9192/ballerina-copilot/v2.0/webhook"
  authentication:
    type: "bearer"
    token: "mock-token"
---

# Role
You are a telegram chat agent.

# Instructions
- Respond to telegram messages briefly.
