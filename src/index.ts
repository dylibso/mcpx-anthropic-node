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
    let response: Awaited<ReturnType<Anthropic["messages"]["create"]>>
    let { messages, ...rest } = body
    let messageIdx = 1
    do {
      response = await this.#anthropic.messages.create({
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
      for (const submessage of response.content) {
        if (submessage.type !== 'tool_use') {
          continue
        }

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
          newMessage.content.push({
            tool_use_id: id,
            type: 'tool_result',
            content: err.toString(),
            is_error: true
          })
        }
      }

      if (response.stop_reason !== 'tool_use') {
        messages.pop()
        break
      }
    } while (1)
    for (; messageIdx < messages.length - 1; ++messageIdx) {
      this.#logger.info({ exchange: messages[messageIdx] }, 'message')
    }
    this.#logger.info({ lastMessage: messages[messageIdx] }, 'final message')
    return response
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
