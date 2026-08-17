import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { Context } from 'cordis'
import type { Tool } from './tools'

/**
 * 文件工具：read / write / edit 三个独立工具（M3 spec 决策 6）。
 *
 * 教学要点：
 * - 三个操作是**三个声明**：模型按名字选工具，声明（参数 schema）就是给模型的"说明书"。
 * - 相对路径按会话 cwd 解析（cwd 随会话 meta 走，见 loop）；无沙箱（风险明示于 README）。
 * - read/edit 对"文件不存在"是**报错**（rejection）：读不到就是读不到，模型需要失败原因；
 *   write 会创建父目录（工具要能动手"建新东西"）。
 *
 * 命名对齐（2026-08-18，上游工具目录）：工具名 `read`/`write`/`edit`；参数
 * `file_path`（上游 `file_path`）、edit 用 `old_string`/`new_string`（上游同款）——
 * 模型按上游目录调用即可命中，不再吃 UnknownToolError。
 */

interface FsInput {
  file_path: string
}

interface WriteInput extends FsInput {
  content: string
}

interface EditInput extends FsInput {
  old_string: string
  new_string: string
}

function resolvePath(cwd: string, filePath: string): string {
  return isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath)
}

export function createReadFileTool(): Tool {
  return {
    declaration: {
      name: 'read',
      description: '读取一个文本文件的内容。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件路径（相对会话 cwd 或绝对路径）' },
        },
        required: ['file_path'],
      },
    },
    async execute(input: Record<string, unknown>, ctx) {
      const { file_path } = input as unknown as FsInput
      return readFile(resolvePath(ctx.cwd, file_path), 'utf8')
    },
  }
}

export function createWriteFileTool(): Tool {
  return {
    declaration: {
      name: 'write',
      description: '写入文本文件（覆盖已有内容；父目录不存在会自动创建）。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件路径（相对会话 cwd 或绝对路径）' },
          content: { type: 'string', description: '要写入的完整内容' },
        },
        required: ['file_path', 'content'],
      },
    },
    async execute(input: Record<string, unknown>, ctx) {
      const { file_path, content } = input as unknown as WriteInput
      const target = resolvePath(ctx.cwd, file_path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
      return { path: target, bytes: Buffer.byteLength(content) }
    },
  }
}

export function createEditFileTool(): Tool {
  return {
    declaration: {
      name: 'edit',
      description: '把文件里唯一的一处旧文本精确替换为新文本（旧文本必须恰好出现一次）。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件路径（相对会话 cwd 或绝对路径）' },
          old_string: { type: 'string', description: '要被替换的旧文本' },
          new_string: { type: 'string', description: '替换上去的新文本' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
    async execute(input: Record<string, unknown>, ctx) {
      const { file_path, old_string, new_string } = input as unknown as EditInput
      const target = resolvePath(ctx.cwd, file_path)
      const text = await readFile(target, 'utf8')
      const occurrences = text.split(old_string).length - 1
      if (occurrences === 0) throw new Error(`edit：文件里找不到旧文本（${target}）`)
      if (occurrences > 1) {
        throw new Error(`edit：旧文本出现 ${occurrences} 次，不是唯一（${target}）`)
      }
      // 字面替换：函数替换器让 new_string 里的 $& / $$ / $` / $' 按原文写入，
      // 不被 String.replace 解释成替换模式（上游同款字面语义）。
      await writeFile(target, text.replace(old_string, () => new_string), 'utf8')
      return { path: target, replaced: true }
    },
  }
}

/**
 * read / write / edit 工具插件（工厂名保留 readFileTool 等导出名，声明名已对齐上游）。
 * M6 注册可逆：注册返回撤销函数，经 ctx.effect 挂接——插件卸载即撤销注册。
 */
export const readFileTool = Object.assign(
  function readFileTool(ctx: Context): void {
    const off = ctx.tools.register(createReadFileTool())
    ctx.effect(() => () => off())
  },
  { inject: ['tools'] },
)

/** write_file 工具插件。 */
export const writeFileTool = Object.assign(
  function writeFileTool(ctx: Context): void {
    const off = ctx.tools.register(createWriteFileTool())
    ctx.effect(() => () => off())
  },
  { inject: ['tools'] },
)

/** edit_file 工具插件。 */
export const editFileTool = Object.assign(
  function editFileTool(ctx: Context): void {
    const off = ctx.tools.register(createEditFileTool())
    ctx.effect(() => () => off())
  },
  { inject: ['tools'] },
)
