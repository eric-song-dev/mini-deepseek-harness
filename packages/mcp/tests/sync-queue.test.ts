import { describe, expect, it } from 'vitest'
import { createSyncQueue } from '../src/sync-queue'

/**
 * 代际同步队列契约（M9 修复：list_changed 并发重同步泄漏 + onclose 竞态）。
 * 关键语义：
 * - 串行化：一次同步未结算，下一次入队的同步绝不开始；
 * - 代栅栏：revoke 后，未开始的同步跳过（sync 不执行）；在途同步完成后其
 *   结果被 disposeResult 回收、绝不 commit；
 * - sync 抛错：enqueue reject（初始同步靠它 fail-fast），队列仍可继续。
 */

/** 手动结算的 promise（测试控制同步的结算时机）。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 让微任务队列排空一次（run 启动）。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('createSyncQueue（代际同步队列）', () => {
  it('串行化：前一次同步未结算时，后一次入队的同步不开始；串行下后一次能看到前一次 commit 的状态', async () => {
    const gate = deferred<number>()
    const starts: number[] = []
    let state = 0
    const queue = createSyncQueue<number>({
      sync: async () => {
        starts.push(starts.length)
        // 第一次同步悬在 gate 上；第二次同步看到的是第一次 commit 后的状态
        return starts.length === 1 ? await gate.promise : state + 1
      },
      commit: (result) => {
        state = result
      },
      disposeResult: () => {},
    })

    const first = queue.enqueue()
    const second = queue.enqueue()
    await flush()
    // 第一个 run 已开始并悬在 gate 上；第二个绝不允许提前开始
    expect(starts).toEqual([0])

    gate.resolve(10)
    await first
    expect(state).toBe(10)
    await second
    expect(starts).toEqual([0, 1])
    // 第二次同步执行时看到了第一次 commit 的状态（10 + 1）
    expect(state).toBe(11)
  })

  it('revoke 后未开始的同步全部跳过：sync 不被调用、不 commit', async () => {
    const starts: number[] = []
    const committed: number[] = []
    const queue = createSyncQueue<number>({
      sync: async () => {
        starts.push(starts.length)
        return 1
      },
      commit: (result) => {
        committed.push(result)
      },
      disposeResult: () => {},
    })

    const first = queue.enqueue()
    const second = queue.enqueue()
    queue.revoke() // 两个 run 都还没开始执行（还在微任务队列里）

    await first
    await second
    expect(starts).toEqual([])
    expect(committed).toEqual([])
  })

  it('在途同步完成后代已失效：结果被 disposeResult 回收、绝不 commit', async () => {
    const gate = deferred<number>()
    const disposed: number[] = []
    const committed: number[] = []
    const queue = createSyncQueue<number>({
      sync: async () => await gate.promise,
      commit: (result) => {
        committed.push(result)
      },
      disposeResult: (result) => {
        disposed.push(result)
      },
    })

    const run = queue.enqueue()
    await flush() // run 已开始、悬在 gate 上
    queue.revoke() // 连接在同步期间断开

    gate.resolve(42)
    await run
    expect(disposed).toEqual([42])
    expect(committed).toEqual([])
  })

  it('sync 抛错：enqueue reject（初始同步靠它 fail-fast），队列仍可继续下一次', async () => {
    let fail = true
    const committed: number[] = []
    const queue = createSyncQueue<number>({
      sync: async () => {
        if (fail) throw new Error('网络断了')
        return 7
      },
      commit: (result) => {
        committed.push(result)
      },
      disposeResult: () => {},
    })

    await expect(queue.enqueue()).rejects.toThrow('网络断了')
    fail = false
    await queue.enqueue()
    expect(committed).toEqual([7])
  })

  it('同步成功且代仍有效：commit 收到结果', async () => {
    const committed: number[] = []
    const queue = createSyncQueue<number>({
      sync: async () => 5,
      commit: (result) => {
        committed.push(result)
      },
      disposeResult: () => {},
    })
    await queue.enqueue()
    expect(committed).toEqual([5])
  })
})
