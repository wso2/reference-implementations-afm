---
spec_version: '0.3.0'
name: "SlackWebhookAgent"
description: "A test agent for provider-style webhook AFM processing."
author: "Copilot"
version: "0.1.0"
interfaces:
  - type: webhook
    prompt: "[${http:payload.type}] Reply to ${http:payload.message.text}"
    subscription:
      protocol: "provider"
      provider: "slack"
      provider_config:
        signing_secret: "test-signing-secret"
    exposure:
      http:
        path: "/slack"
max_iterations: 5
model:
  provider: "openai"
  url: "https://api.openai.com/v1/chat/completions"
  authentication:
    type: "bearer"
    token: "mock-token"
---

# Role
You are a Slack assistant that responds to incoming callbacks.

# Instructions
- Read the incoming Slack event.
- Generate a response for the user.
