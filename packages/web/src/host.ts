import 'cordis'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { Context } from 'cordis'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { agentLoop } from '@mini-dsh/agent'
import type { AgentLoop, AgentLoopConfig } from '@mini-dsh/agent'
import type { Session, SessionEvent } from '@mini-dsh/session'
import { createRpcBridge } from './bridge'
import type { RpcBridge } from './bridge'
import { attachWsBridge } from './ws-server'

/** RPC 参数错误（client 传了坏形状的 params）。 */
export class RpcBadParamsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadParamsError'
  }
}

export interface WebHostOptions {
  /** HTTP 监听端口；0 = 随机（测试）；默认 8080。 */
  port?: number
  /** 监听地址；默认 127.0.0.1。 */
  host?: string
  /** 静态文件目录（client 构建产物）；缺省不服务静态文件。 */
  staticDir?: string
  /** 会话 loop 的 system prompt。 */
  systemPrompt?: string
  /** 会话 loop 的流式开关（产生 assistant/stream 事件）；默认开。 */
  stream?: boolean
  /** 注入桥（测试/内嵌）：跳过 WS 传输，只做 RPC 门面。 */
  bridge?: RpcBridge
}

/** webHost 的运行句柄（demo 打印地址、测试取随机端口）。 */
export interface WebHostHandle {
  port: number
  url: string
  close: () => Promise<void>
}

/** 常驻会话：Session 本身 + 它的 loop 句柄。 */
interface Resident {
  session: Session
  loop: AgentLoop
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

function requireString(params: unknown, key: string): string {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new RpcBadParamsError(`params 必须是对象（需要 ${key}）`)
  }
  const value = (params as Record<string, unknown>)[key]
  if (typeof value !== 'string' || value === '') throw new RpcBadParamsError(`${key} 必须是非空字符串`)
  return value
}

function parseCreateParams(params: unknown): { title?: string; cwd?: string } {
  if (params === undefined) return {}
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new RpcBadParamsError('session.create 的 params 必须是对象')
  }
  const raw = params as Record<string, unknown>
  const input: { title?: string; cwd?: string } = {}
  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string') throw new RpcBadParamsError('title 必须是字符串')
    input.title = raw.title
  }
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== 'string') throw new RpcBadParamsError('cwd 必须是字符串')
    input.cwd = raw.cwd
  }
  return input
}

/**
 * webHost 插件（M4）：把 SessionManager / agent-loop 的能力暴露成远程操作。
 *
 * - RPC 最小集：session.list / session.create / session.resume / session.send。
 * - 实时通道：会话 ctx 上挂桥接适配插件，监听 session/append → 桥推送事件
 *   （loop 本体一行不改——定夺点 A：loop 与桥靠"事件 + 服务入口"对接）。
 * - 会话常驻：列表即内存会话表 + 磁盘元数据（resume 幂等）。
 * - HTTP 只做两件事：静态文件 + WS 升级握手（WebSocket 是唯一实时通道）。
 *
 * `inject: ['session-manager']`：换持久化后端只是换提供服务的插件，host 零改动。
 */
export const webHost = Object.assign(
  async function webHost(ctx: Context, options: WebHostOptions = {}): Promise<void> {
    const manager = ctx['session-manager']
    const bridge = options.bridge ?? createRpcBridge()
    const stream = options.stream ?? true
    const residents = new Map<string, Resident>()
    const wss = options.bridge ? undefined : new WebSocketServer({ noServer: true })

    // —— 会话常驻表：resume 幂等；桥接适配插件把日志追加实时推到 client ——
    const attachSession = async (session: Session): Promise<Resident> => {
      const existing = residents.get(session.id)
      if (existing) return existing
      const loopConfig: AgentLoopConfig = { stream }
      if (options.systemPrompt !== undefined) loopConfig.systemPrompt = options.systemPrompt
      const fiber = await session.ctx.plugin(agentLoop, loopConfig)
      const loop = fiber.ctx['agent-loop']
      session.ctx.on('session/append', (event: SessionEvent) => {
        bridge.pushEvent(session.id, event)
      })
      const resident: Resident = { session, loop }
      residents.set(session.id, resident)
      return resident
    }
    const getSession = async (id: string): Promise<Resident> => {
      const existing = residents.get(id)
      if (existing) return existing
      const session = await manager.resume(id)
      return attachSession(session)
    }

    // —— RPC 方法最小集（客户端只认这些名字，桥负责配对与错误）——
    bridge.handle('session.list', () => manager.list())
    bridge.handle('session.create', async (params) => {
      const session = await manager.create(parseCreateParams(params))
      await attachSession(session)
      return session.meta
    })
    bridge.handle('session.resume', async (params) => {
      const id = requireString(params, 'id')
      const { session } = await getSession(id)
      // 返回完整历史：client 重连后靠它恢复视图（resume 幂等）
      return { meta: session.meta, events: session.log }
    })
    bridge.handle('session.send', async (params) => {
      const id = requireString(params, 'id')
      const content = requireString(params, 'content')
      const { loop } = await getSession(id)
      await loop.chat(content)
      // 本轮的事件已在 chat 期间经桥推完；这里只确认"轮次完成"
      return {}
    })

    // —— HTTP：静态文件 + WS 升级握手 ——
    const staticDir = options.staticDir

    const serveHttp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end()
        return
      }
      if (staticDir === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('未配置静态文件目录')
        return
      }
      let pathname: string
      try {
        pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
      } catch {
        res.writeHead(400).end()
        return
      }
      // 目录穿越防护：解析后必须仍在 staticDir 内
      const root = resolve(staticDir)
      const relative = pathname.endsWith('/') ? `${pathname}index.html` : pathname
      const target = resolve(root, `.${relative}`)
      if (target !== root && !target.startsWith(root + sep)) {
        res.writeHead(403).end()
        return
      }
      try {
        const info = await stat(target)
        if (!info.isFile()) {
          res.writeHead(404).end()
          return
        }
        const body = await readFile(target)
        res.writeHead(200, {
          'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
          'content-length': body.length,
        })
        res.end(req.method === 'HEAD' ? undefined : body)
      } catch {
        res.writeHead(404).end()
      }
    }

    const server = createServer((req, res) => {
      void serveHttp(req, res)
    })
    if (wss) {
      attachWsBridge(bridge, wss)
      server.on('upgrade', (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          wss.emit('connection', ws, req)
        })
      })
    }

    const port = options.port ?? 8080
    const host = options.host ?? '127.0.0.1'
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        resolveListen()
      })
    })
    const address = server.address()
    const actualPort = typeof address === 'object' && address !== null ? address.port : port
    const handle: WebHostHandle = {
      port: actualPort,
      url: `http://${host}:${actualPort}`,
      close: async () => {
        for (const client of wss?.clients ?? []) client.terminate()
        await new Promise<void>((resolveClose) => {
          wss?.close()
          server.close(() => resolveClose())
        })
        for (const { session } of residents.values()) await session.dispose()
        residents.clear()
      },
    }

    ctx.provide('rpc-bridge', bridge)
    ctx.provide('web-host', handle)
    // 随 fiber 卸载关闭服务器与常驻会话（cordis 的 effect 收尾，无 dispose 事件）
    ctx.effect(() => () => {
      void handle.close()
    })
  },
  { inject: ['session-manager'] },
)

// 服务类型增强：插件可通过 ctx['rpc-bridge'] / ctx['web-host'] 取到。
declare module 'cordis' {
  interface Context {
    'rpc-bridge': RpcBridge
    'web-host': WebHostHandle
  }
}
