---
spec_version: '0.3.0'
name: "SlackTestAgent"
description: "A test agent for slack platformchat notification mode."
author: "Copilot"
version: "0.1.0"
interfaces:
  - type: platformchat
    platform: slack
    mode: notification
    prompt: "Slack event: ${http:payload.event.text}"
    platform_config:
      signing_secret: "test-slack-signing-secret"
max_iterations: 5
model:
  provider: "wso2"
  url: "http://localhost:9192/ballerina-copilot/v2.0/webhook"
  authentication:
    type: "bearer"
    token: "mock-token"
---

# Role
You are a slack chat agent.

# Instructions
- Respond to slack messages briefly.
