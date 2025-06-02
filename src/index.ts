import type {
  ContentBlockParam,
  MessageCreateParamsNonStreaming,
  Tool,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/index.js'
import type { Logger, SessionOptions } from '@dylibso/mcpx'
import { Session } from '@dylibso/mcpx'
import type { RequestOptions } from '@anthropic-ai/sdk/core'
import { Anthropic, BadRequestError } from '@anthropic-ai/sdk'
import { pino } from 'pino'

export interface BaseDriverOptions {
  anthropic: Anthropic,
  logger?: Logger,
}

export type DriverOptions = (
  (BaseDriverOptions & { session: Session }) |
  (BaseDriverOptions & { sessionOptions?: SessionOptions, sessionId: string, profile?: string })
)

export interface McpxAnthropicTurn {
  response: Anthropic.Messages.Message
  messages: Anthropic.Messages.MessageParam[]
  index: number
  toolCallIndex?: number
  done: boolean
}

export interface McpxAnthropicStage {
  response: Anthropic.Messages.Message
  messages: Anthropic.Messages.MessageParam[]
  index: number
  toolCallIndex?: number
  submessageIdx?: number
  status: 'ready' | 'pending' | 'input_wait'
}


function anthropicToolCallToMcpxToolCall(submessage: any): any {
  return {
    method: 'tools/call',
    params: {
      name: submessage.name,
      arguments: submessage.input,
    },
  }
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
        await this.nextTurn({
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

  async nextTurn(body: MessageCreateParamsNonStreaming, messageIdx: number, options: RequestOptions): Promise<McpxAnthropicTurn> {

    let { messages, ...rest } = body

    let stage: McpxAnthropicStage = {
      messages,
      index: messageIdx,
      status: 'pending',
      response: {} as Anthropic.Messages.Message,
    }
    stage = await this.next(stage, rest, options)
    switch (stage.status) {
      case 'ready':
        return {
          messages: stage.messages,
          index: stage.index,
          response: stage.response,
          done: true,
        }
      case 'pending':
        return {
          messages: stage.messages,
          index: stage.index,
          response: stage.response,
          done: false,
        }
      case 'input_wait':
        do {
          stage = await this.next(stage, rest, options)
        } while (stage.status === 'input_wait')
        return {
          messages: stage.messages,
          index: stage.index,
          response: stage.response,
          done: stage.status === 'ready',
        }
    }
  }


  private async call(convertedToolCall: any, toolCallId: string): Promise<ContentBlockParam> {
    try {
      const abortcontroller = new AbortController()
      const result = await this.#session.handleCallTool(
        convertedToolCall,
        { signal: abortcontroller.signal },
      )

      return {
        tool_use_id: toolCallId,
        type: 'tool_result',
        content: Array.isArray(result.content)
          ? result.content.map(xs => {
            return { [xs.type]: xs[xs.type], type: xs.type }
          }) as any
          : result.content,
      }
    } catch (err: any) {
      this.#logger.error(
        {
          tool_use_id: toolCallId,
          name,
          error: err.message,
          stack: err.stack,
        },
        'tool use failed',
      )
      return {
        tool_use_id: toolCallId,
        type: 'tool_result',
        content: err.toString(),
        is_error: true,
      }
    }
  }

  async next(stage: McpxAnthropicStage, config: any, requestOptions?: RequestOptions<unknown>): Promise<McpxAnthropicStage> {
    const { response, messages, index, status, toolCallIndex } = stage
    switch (status) {
      case 'pending': {
        const tools = config.tools?.map(mcpxToolToAnthropic) || this.#tools
        const tool_choice =
          config.tool_choice ? { type: 'tool', name: config.tool_choice } : { type: 'auto' }

        let response: Anthropic.Messages.Message
        try {
          response = await this.#anthropic.messages.create({
            ...config,
            tools,
            tool_choice,
            messages,
          }, requestOptions)
        } catch (err: any) {
          throw ToolSchemaError.parse(err, this.#tools)
        }

        messages.push({
          role: response.role,
          content: response.content,
        })

        let messageIdx = index
        for (; messageIdx < messages.length; ++messageIdx) {
          this.#logger.info({ exchange: messages[messageIdx] }, 'message')
        }
        const newMessage = { role: 'user' as const, content: [] as ContentBlockParam[] }
        messages.push(newMessage)
        let toolUseCount = 0
        let submessageIdx = 0;
        for (const submessage of response.content) {
          if (submessage.type === 'tool_use') {
            return { response, messages, index: messageIdx, status: 'input_wait', toolCallIndex: toolUseCount, submessageIdx }
          }
          submessageIdx++
        }

        if (response.stop_reason === 'tool_use') {
          return { response,  messages, index: messageIdx, status: 'pending' }
        }

        if (response.stop_reason === 'end_turn' && toolCallIndex !== undefined && toolCallIndex > 0) {
          return { response,  messages, index: messageIdx, status: 'pending' }
        }

        messages.pop()
        this.#logger.info({ lastMessage: messages[messages.length - 1], stopReason: response.stop_reason }, 'final message')
        return { response,  messages, index: messageIdx, status: 'ready' }
      }
      case 'input_wait': {
        const newMessage = messages[index]
        const content = newMessage.content as ContentBlockParam[]
        const { tool, submessageIdx, toolCallIndex, toolCallLength, toolCallId } =
          this.parseNextToolCall(stage)

        content.push(await this.call(tool, toolCallId!))

        if (submessageIdx >= toolCallLength) {
          return { response, messages, index, status: 'pending' }
        } else {
          return { response, messages, index, status: 'input_wait', toolCallIndex, submessageIdx }
        }
      }
      default:
        throw new Error("Illegal status: " + status)
    }
  }

  parseNextToolCall(stage: McpxAnthropicStage) {
    const { status, messages, index } = stage
    if (status !== 'input_wait') {
      throw new Error("Cannot parse next tool call: invalid status " + status)
    }
    const toolUseCount = stage.toolCallIndex!
    const submessageIdx = stage.submessageIdx!
    const inputMessage = messages[index-1]

    // when status == 'input_wait' it is always a tool call,
    // newMessage.content is always a ContentBlockParam[]
    const submessage = inputMessage.content[submessageIdx] as ToolUseBlock

    const nextTool = toolUseCount + 1
    const nextSubmessage = submessageIdx + 1

    return {
      tool: anthropicToolCallToMcpxToolCall(submessage),
      toolCallIndex: nextTool,
      toolCallLength: inputMessage.content.length,
      submessageIdx: nextSubmessage,
      toolCallId: submessage.id
    }
  }

}

function mcpxToolToAnthropic(tool: any) {
  return {
    // So, you're saying you folks write a lot of Python, eh? Well, it certainly doesn't show.
    input_schema: tool.inputSchema,
    name: tool.name,
    description: tool.description,
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
    tools: mcpTools.map(mcpxToolToAnthropic)
  })
}

export class ToolSchemaError extends Error {
  static parse(err: any, tools: Tool[]): any {
    const error = err?.error?.error
    const message = error?.message
    if (error?.type === 'invalid_request_error' && message?.includes('input_schema')) {
      if (message.startsWith("tools.")) {
        const parts: string[] = message.split('.')
        const index = parseInt(parts[1])
        return new ToolSchemaError(err, index, tools[index].name)
      }
    }
    return err
  }

  public readonly originalError: any
  public readonly toolIndex: number
  public readonly toolName: string
  constructor(error: any, toolIndex: number, toolName: string) {
    super(`Invalid schema for tool #${toolIndex}: '${toolName}'\nCaused by: ${error.message}`)
    this.originalError = error;
    this.toolIndex = toolIndex
    this.toolName = toolName
  }

}