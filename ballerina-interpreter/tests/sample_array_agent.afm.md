---
spec_version: '0.3.0'
name: "ArrayTestAgent"
description: "Test agent with array output signature"
interfaces:
  - type: webchat
    signature:
      input:
        type: object
        properties:
          query:
            type: string
        required: [query]
      output:
        type: array
        items:
          type: string
    exposure:
      http:
        path: /list
model:
  provider: wso2
  url: "http://localhost:9191/ballerina-copilot/v2.0"
  authentication:
    type: bearer
    token: "test-token"
---
# Role
You are a list generator agent.

# Instructions
Return a list of items based on user queries.
