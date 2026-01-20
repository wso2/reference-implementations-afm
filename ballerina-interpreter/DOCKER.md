# AFM Ballerina Interpreter

This repository provides a Docker image of an AFM interpreter that generates and runs agents in Ballerina based on a provided AFM file.

You can run agents by mounting your `.afm.md` definition file and passing any required environment variables.

## Model Providers

Currently supports OpenAI, Anthropic, and the default WSO2 Model Provider.

To use the default WSO2 provider, set the `WSO2_MODEL_PROVIDER_TOKEN` environment variable - use the token generated via the **Ballerina: Configure default WSO2 model provider** VS Code command with the Ballerina plugin installed.

## Example Usage

```bash
docker run -p 8085:8085 \
  -e WSO2_MODEL_PROVIDER_TOKEN=<your-token> \
  -v ./friendly_assistant.afm.md:/agent.afm.md \
  ghcr.io/__OWNER__/afm-ballerina-interpreter:latest /agent.afm.md
```

### Run a [simple webchat agent](https://wso2.github.io/agent-flavored-markdown/examples/friendly_assistant.afm/)

Create `friendly_assistant.afm.md`:

```markdown
---
name: "Friendly Assistant"
description: "A friendly conversational assistant that helps users with various tasks."
version: "0.1.0"
license: "Apache-2.0"
interfaces:
  - type: webchat
max_iterations: 5
---

# Role

You are a friendly and helpful conversational assistant. Your purpose is to engage in
natural, helpful conversations with users, answering their questions, providing
information, and assisting with various tasks to the best of your abilities.

# Instructions

- Always respond in a friendly and conversational tone
- Keep your responses clear, concise, and easy to understand
- If you don't know something, be honest about it
- Ask clarifying questions when the user's request is ambiguous
- Be helpful and try to provide practical, actionable advice
- Maintain context throughout the conversation
- Show empathy and understanding in your responses
```

Run it:

```bash
docker run -p 8085:8085 \
  -e WSO2_MODEL_PROVIDER_TOKEN=<your-token> \
  -v ./friendly_assistant.afm.md:/agent.afm.md \
  ghcr.io/__OWNER__/afm-ballerina-interpreter:latest /agent.afm.md
```

### Run a [consolechat agent](https://wso2.github.io/agent-flavored-markdown/examples/math_tutor.afm/)

```bash
docker run -it \
  -e WSO2_MODEL_PROVIDER_TOKEN=<your-token> \
  -v ./test-math-tutor-function.afm.md:/agent.afm.md \
  ghcr.io/__OWNER__/afm-ballerina-interpreter:latest /agent.afm.md
```

### Run a [GitHub PR analyzer with a webhook trigger](https://wso2.github.io/agent-flavored-markdown/examples/pull_request_analyzer.afm/)

```bash
docker run -p 8085:8085 \
  -e WSO2_MODEL_PROVIDER_TOKEN=<your-wso2-model-token> \
  -e GITHUB_TOKEN=<your-github-token> \
  -e GITHUB_WEBHOOK_SECRET=<your-github-webhook-secret> \
  -e CALLBACK_URL=<your-callback-url> \
  -v ./github_pr_drift_checker.afm.md:/agent.afm.md \
  ghcr.io/__OWNER__/afm-ballerina-interpreter:latest /agent.afm.md
```
