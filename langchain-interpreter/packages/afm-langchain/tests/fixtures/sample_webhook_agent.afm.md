---
spec_version: '0.3.0'
name: "WebhookTestAgent"
description: "A test agent for webhook AFM processing."
author: "Copilot"
version: "0.1.0"
interfaces:
  - type: webhook
    prompt: "[${http:payload.event}] Process the following order event: ${http:payload}"
    subscription:
      protocol: "websub"
      hub: "http://localhost:9193/websub/hub"
      topic: "http://localhost:9193/events/orders"
      callback: "http://localhost:8080/webhook"
max_iterations: 5
model:
  provider: "openai"
  url: "https://api.openai.com/v1/chat/completions"
  authentication:
    type: "bearer"
    token: "mock-token"
---

# Role
You are an order processing assistant that handles webhook events for e-commerce orders.

# Instructions
- Process incoming order events from the webhook
- Extract relevant information from the event payload
- Provide clear confirmation of the action taken
- Log important details like order ID, customer information, and amounts
