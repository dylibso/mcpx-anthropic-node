import { stdin as input, stdout as output } from 'node:process';
import createDriver from '@dylibso/mcpx-anthropic'
import readline from 'node:readline/promises';
import Anthropic from '@anthropic-ai/sdk'
import pretty from 'pino-pretty'
import fs from "node:fs"
import pino from 'pino'

const rl = readline.createInterface({ input, output });
const logger = pino(pretty({ colorize: true }))

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

async function main() {
  const mcpx = await createDriver({
    anthropic,
    logger,
    sessionId: process.env.MCP_RUN_SESSION_ID,
    system: `
You are a helpful AI assistant with access to various external tools and APIs. Your goal is to complete tasks thoroughly and autonomously by making full use of these tools. Here are your core operating principles:

1. Take initiative - Don't wait for user permission to use tools. If a tool would help complete the task, use it immediately.
2. Chain multiple tools together - Many tasks require multiple tool calls in sequence. Plan out and execute the full chain of calls needed to achieve the goal.
3. Handle errors gracefully - If a tool call fails, try alternative approaches or tools rather than asking the user what to do.
4. Make reasonable assumptions - When tool calls require parameters, use your best judgment to provide appropriate values rather than asking the user.
5. Show your work - After completing tool calls, explain what you did and show relevant results, but focus on the final outcome the user wanted.
6. Be thorough - Use tools repeatedly as needed until you're confident you've fully completed the task. Don't stop at partial solutions.

Your responses should focus on results rather than asking questions. Only ask the user for clarification if the task itself is unclear or impossible with the tools available.
`,
  })

  const messages = [];

  console.log('Chat started. Type "exit" to quit.\n');

  while (true) {
    const input = await rl.question('You: ')

    if (input.toLowerCase() === 'exit') {
      console.log('Goodbye!');
      rl.close();
      break;
    }

    messages.push({ role: 'user', content: input });

    let response = await mcpx.createMessage({
      max_tokens: 1024,
      messages,
      model: 'claude-3-5-sonnet-latest',
    });

    if (Array.isArray(response.content)) {
      response.content.map((xs) => {
        console.log("\nAssistant:", xs[xs.type]);
      })
    } else {
      console.log("\nAssistant:", response.content)
    }

    //optionally write message log
    //fs.writeFileSync('./messages.json', JSON.stringify(messages, null, 4))
  }
}

await main()
process.exit(0)
