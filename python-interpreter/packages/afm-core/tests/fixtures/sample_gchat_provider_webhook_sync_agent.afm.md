---
spec_version: '0.3.0'
name: "GChatSyncWebhookAgent"
description: "A test agent for GChat provider-style webhook with synchronous responses."
author: "Copilot"
version: "0.1.0"
interfaces:
  - type: webhook
    prompt: "[${http:payload.type}] Reply to ${http:payload.message.text}"
    signature:
      output:
        type: object
        properties:
          text:
            type: string
    subscription:
      protocol: "provider"
      provider: "gchat"
      provider_config:
        verification_token: "test-verification-token"
    exposure:
      http:
        path: "/gchat"
max_iterations: 5
model:
  provider: "openai"
  url: "https://api.openai.com/v1/chat/completions"
  authentication:
    type: "bearer"
    token: "mock-token"
---

# Role
You are a Google Chat assistant that responds to incoming events synchronously.

# Instructions
- Read the incoming Google Chat event.
- Generate a response for the user.
