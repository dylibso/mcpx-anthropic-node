import { ContentBlockParam, MessageCreateParamsNonStreaming, Tool } from '@anthropic-ai/sdk/resources/index.js'
import { Logger, Session, SessionOptions } from '@dylibso/mcpx'
import { RequestOptions } from '@anthropic-ai/sdk/core'
import Anthropic from '@anthropic-ai/sdk'
import { pino } from 'pino'

export interface BaseDriverOptions {
  anthropic: Anthropic,
  logger?: Logger,
}

export type DriverOptions = (
  (BaseDriverOptions & { session: Session }) |
  (BaseDriverOptions & { sessionOptions?: SessionOptions, sessionId: string, profile?: string })
)

export interface McpxAnthropicStage {
  response: Anthropic.Messages.Message
  messages: Anthropic.Messages.MessageParam[]
  index: number
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null,
  done: boolean
}

/**
 * A Driver wrapping an Anthropic client and MCPX session.
 *
 * Provides a `createMessage` method, which wraps {@link Anthropic.Messages.Message | the Anthropic createMessage} method.
 * Calling this method will automatically dispatch `tool_use` requests to the MCPX Session.
 */
export class Driver {
  #anthropic: Anthropic
  #logger: Logger
  #session: Session
  #tools: Tool[]
  constructor(opts: {
    anthropic: Anthropic,
    logger: Logger,
    session: Session,
    tools: Tool[]
  }) {
    this.#anthropic = opts.anthropic
    this.#logger = opts.logger
    this.#session = opts.session
    this.#tools = opts.tools
  }

  async createMessage(body: MessageCreateParamsNonStreaming, options: RequestOptions) {
    let response: Anthropic.Messages.Message
    let { messages, ...rest } = body
    let messageIdx = 1
    do {
      const result =
        await this.messageStep({
          ...rest,
          ...(this.#tools.length ? { tools: this.#tools } : {}),
          messages,
        }, messageIdx, options)
      response = result.response
      messages = result.messages
      messageIdx = result.index
      if (result.done) {
        break
      }
    } while (1)
    return response
  }

  async messageStep(body: MessageCreateParamsNonStreaming, messageIdx: number, options: RequestOptions): Promise<McpxAnthropicStage> {
    let { messages, ...rest } = body
    let response: Anthropic.Messages.Message = await this.#anthropic.messages.create({
      ...rest,
      ...(this.#tools.length ? { tools: this.#tools } : {}),
      messages,
    }, options)

    messages.push({
      role: response.role,
      content: response.content,
    })

    for (; messageIdx < messages.length; ++messageIdx) {
      this.#logger.info({ exchange: messages[messageIdx] }, 'message')
    }

    const newMessage = { role: 'user' as const, content: [] as ContentBlockParam[] }
    messages.push(newMessage)
    let toolUseCount = 0
    for (const submessage of response.content) {
      if (submessage.type !== 'tool_use') {
        continue
      }

      ++toolUseCount
      const { id, input, name } = submessage
      try {
        const abortcontroller = new AbortController()
        const result = await this.#session.handleCallTool(
          {
            method: 'tools/call',
            params: {
              name,
              arguments: input as any
            },
          },
          { signal: abortcontroller.signal }
        )

        newMessage.content.push({
          tool_use_id: id,
          type: 'tool_result',
          content: Array.isArray(result.content)
            ? result.content.map(xs => {
              return { [xs.type]: xs[xs.type], type: xs.type }
            }) as any
            : result.content
        })
      } catch (err: any) {
        this.#logger.error(
          {
            tool_use_id: id,
            name,
            error: err.message,
            stack: err.stack,
          },
          'tool use failed'
        )
        newMessage.content.push({
          tool_use_id: id,
          type: 'tool_result',
          content: err.toString(),
          is_error: true
        })
      }
    }

    if (response.stop_reason === 'tool_use') {
      return { response,  messages, index: messageIdx, stopReason: response.stop_reason, done: false }
    }

    if (response.stop_reason === 'end_turn' && toolUseCount > 0) {
      return { response,  messages, index: messageIdx, stopReason: response.stop_reason, done: false }
    }

    messages.pop()
    this.#logger.info({ lastMessage: messages[messages.length - 1], stopReason: response.stop_reason }, 'final message')
    return { response,  messages, index: messageIdx, stopReason: response.stop_reason, done: true }
  }
}

/** Create a driver using an Anthropic client and MCPX Session options. */
export default async function createDriver(opts: DriverOptions) {
  const { anthropic, logger } = opts
  const session: Session = (
    !('session' in opts)
      ? new Session({
        authentication: [
          ["cookie", `sessionId=${opts.sessionId}`]
        ] as [string, string][],
        activeProfile: opts.profile ?? opts.sessionOptions?.activeProfile ?? 'default',
        ...opts.sessionOptions
      })
      : opts.session
  )

  const { tools: mcpTools } = await session.handleListTools({} as any, {} as any)

  return new Driver({
    anthropic,
    logger: logger || (session.logger as any) || pino({ level: 'silent' }),
    session,
    tools: mcpTools.map(tool => {
      return {
        // So, you're saying you folks write a lot of Python, eh? Well, it certainly doesn't show.
        input_schema: tool.inputSchema,
        name: tool.name,
        description: tool.description,
      }
    })
  })
}
