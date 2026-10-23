---
spec_version: '0.4.0'
name: "SlackPlatformChatAgent"
description: "A test agent for Slack platform chat AFM processing."
author: "Copilot"
version: "0.1.0"
interfaces:
  - type: platformchat
    platform: slack
    mode: notification
    prompt: "[${http:payload.type}] Reply to ${http:payload.message.text}"
    platform_config:
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
