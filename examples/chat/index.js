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

    await new Promise(resolve => setTimeout(resolve, 100))
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
