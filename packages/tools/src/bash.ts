import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Context } from 'cordis'
import type { Tool } from './tools'

/**
 * bash 工具：在 shell 里执行一条命令。
 *
 * 教学要点（M3 spec 决策 5）：
 * - 教学版无沙箱（直接执行，风险明示于 README 与教程）；审批挂点 = Tools seam 的
 *   pre-execute hook。
 * - **exit code 是输出不是异常**：非零退出码也算"成功的结果"——模型需要看到失败原因
 *   （stdout/stderr/exit code），而不是一个笼统的 crash。只有 spawn 本身失败（如 cwd
 *   不存在）才 rejection。
 */
const execFileAsync = promisify(execFile)

export interface BashInput {
  command: string
  /** 工作目录；省略时用会话 cwd（上游同款参数名 workdir）。 */
  workdir?: string
}

export interface BashOutput {
  stdout: string
  stderr: string
  exitCode: number
}

export function createBashTool(): Tool {
  return {
    declaration: {
      name: 'bash',
      description: '在 shell 里执行一条命令，返回 stdout/stderr/exit code。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          workdir: { type: 'string', description: '工作目录（默认会话 cwd）' },
        },
        required: ['command'],
      },
    },
    async execute(input: Record<string, unknown>, ctx) {
      const { command, workdir } = input as unknown as BashInput
      try {
        const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
          cwd: workdir ?? ctx.cwd,
          encoding: 'utf8',
          // 教学版放宽到 10MB：stdout 超限会被截断抛错，宁可显式失败也不静默丢数据。
          maxBuffer: 10 * 1024 * 1024,
        })
        return { stdout, stderr, exitCode: 0 } satisfies BashOutput
      } catch (error) {
        const failed = error as {
          stdout?: string
          stderr?: string
          /** 数字 = 命令跑完的非零退出码；字符串（如 ENOENT）= spawn 本身失败。 */
          code?: number | string
        }
        if (typeof failed.code === 'number') {
          return { stdout: failed.stdout ?? '', stderr: failed.stderr ?? '', exitCode: failed.code } satisfies BashOutput
        }
        throw error
      }
    },
  }
}

/**
 * bash 工具插件：把工具注册进 `tools` 服务（inject 等待服务就绪）。
 * M6 注册可逆：注册返回撤销函数，经 ctx.effect 挂接——插件卸载即撤销注册。
 */
export const bashTool = Object.assign(
  function bashTool(ctx: Context): void {
    const off = ctx.tools.register(createBashTool())
    ctx.effect(() => () => off())
  },
  { inject: ['tools'] },
)
