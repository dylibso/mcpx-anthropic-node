# MCPX Anthropic Client

This library allows you connect your [Anthropic](https://www.anthropic.com/) models to
[mcp.run](https://mcp.run) and expose your installed servlets as tools which can be 
invoked in process (without spinning up many server processes).

## Usage

### Install

You just need the mcpx-anthropic library and the anthropic library (if you don't already have it).

```
npm install @dylibso/mcpx-anthropic @anthropic-ai/sdk
```

To get an mcp.run session id, run this command and follow the instructions:

```
npx --yes -p @dylibso/mcpx@latest gen-session
```

### Code

This package exports a message driver designed to wrap the Anthropic `createMessage` API:

```typescript
import Anthropic from "@anthropic-ai/sdk";
import createDriver from "@dylibso/mcpx-anthropic"

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
})

const mcpx = await createDriver({
  anthropic,
  sessionId: process.env.MCP_RUN_SESSION_ID,
})

const messages = [];

// call any tool compatible api, e.g chat completion:
// let's ask it to evalute some javascript. If you have
// this tool installed: https://www.mcp.run/bhelx/eval-js it should
// determine and use this to evaluate it in a sandbox
messages.push({
  role: 'user',
  content: `
    Write a djb2hash function in javascript and evalute it on the string "Hello, World!"
  `
});

// this will automatically process all tool calls
// until there are none left
const response = await mcpx.createMessage({
  max_tokens: 1024,
  messages,
  model: 'claude-3-5-sonnet-latest',
});

console.log(response.content)
//=> The DJB2 hash of the string "Hello, World!" is `-1763540338`.
```

### Examples

* [Example chat application](examples/chat)

