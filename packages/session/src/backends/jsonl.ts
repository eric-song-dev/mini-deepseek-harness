import { access, appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from 'cordis'
import { createHeaderEvent } from '../events'
import type { SessionEvent } from '../events'
import { SessionNotFoundError } from '../persistence'
import type { CreateSessionInput, SessionMeta, SessionPersistence } from '../persistence'

export interface JsonlOptions {
  /** 会话文件目录；默认 `<DSH_HOME 或 ./.mini-dsh>/sessions`。 */
  dir?: string
}

/** 存储位置约定：`<DSH_HOME>/sessions`，无 DSH_HOME 时用 `./.mini-dsh/sessions`。 */
export function defaultSessionDir(): string {
  const base = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : resolve('.mini-dsh')
  return resolve(base, 'sessions')
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function parseLine(line: string): SessionEvent {
  return JSON.parse(line) as SessionEvent
}

/**
 * JSONL 持久化后端：每个会话一个 `<dir>/<id>.jsonl` 文件。
 *
 * - 首行是 session/created 头记录（seq=1，payload=meta），之后每行一条 SessionEvent。
 * - 写 = 追加一行（appendFile），读 = 按行 JSON.parse。
 * - 单文件追加、不做事务：崩溃窗口由 M1 的恢复逻辑兜底（load 时补 turn/end）。
 * - 实现刻意朴素：不引数据库、不引序列化库 —— 教学上"文件即日志"一目了然。
 */
export function createJsonlPersistence(options: JsonlOptions = {}): SessionPersistence {
  const dir = options.dir ?? defaultSessionDir()
  const fileOf = (id: string) => resolve(dir, `${id}.jsonl`)

  const locate = async (id: string): Promise<SessionMeta | undefined> => {
    const file = fileOf(id)
    if (!(await fileExists(file))) return undefined
    const first = (await readFile(file, 'utf8')).split('\n')[0]
    if (first === undefined) return undefined
    return parseLine(first).payload as SessionMeta
  }

  const create = async (input: CreateSessionInput): Promise<SessionMeta> => {
    const meta: SessionMeta = {
      id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      title: input.title ?? '',
      createdAt: Date.now(),
      cwd: input.cwd ?? process.cwd(),
      ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
      ...(input.depth === undefined ? {} : { depth: input.depth }),
    }
    await mkdir(dir, { recursive: true })
    // M8：seed 是已平移好 seq 的事件前缀（manager 负责），后端只按原样写在头记录之后。
    const lines = [createHeaderEvent(meta), ...(input.seed ?? [])]
      .map((event) => JSON.stringify(event))
      .join('\n')
    await writeFile(fileOf(meta.id), `${lines}\n`)
    return meta
  }

  const append = async (id: string, event: SessionEvent): Promise<void> => {
    const file = fileOf(id)
    if (!(await fileExists(file))) throw new SessionNotFoundError(id)
    await appendFile(file, `${JSON.stringify(event)}\n`)
  }

  const load = async (id: string): Promise<SessionEvent[]> => {
    const file = fileOf(id)
    if (!(await fileExists(file))) throw new SessionNotFoundError(id)
    const text = await readFile(file, 'utf8')
    return text.split('\n').filter((line) => line.length > 0).map(parseLine)
  }

  const list = async (): Promise<SessionMeta[]> => {
    const metas: SessionMeta[] = []
    try {
      const entries = await readdir(dir)
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue
        const meta = await locate(entry.slice(0, -'.jsonl'.length))
        if (meta) metas.push(meta)
      }
    } catch {
      // 目录不存在视为没有会话
    }
    metas.sort((a, b) => b.createdAt - a.createdAt)
    return metas
  }

  return { locate, create, append, load, list }
}

/**
 * JSONL 后端插件：把后端注册成 `session-persistence` 服务。
 * 换后端（如将来的 SQLite）就是换这一个插件，其余代码不动 —— seam 的意义。
 */
export function jsonlPersistence(ctx: Context, options: JsonlOptions): void {
  ctx.provide('session-persistence', createJsonlPersistence(options))
}
