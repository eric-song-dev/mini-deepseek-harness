/**
 * 代际同步队列（M9 修复）：把 MCP 的"重同步"串行化，并给连接代打栅栏。
 *
 * 修掉的两个并发竞态（上游 syncChain / isCurrent 的 mini 版）：
 * - 两次快速 list_changed 并发跑 syncTools：各自 dispose 旧代、注册新代，最后
 *   settle 的那代之外，另一代的撤销函数被丢弃 → 工具永久滞留注册表（泄漏）。
 *   串行化后每次 sync 执行时读到的都是上一次 commit 后的状态，绝无并发；
 * - onclose 与在途重同步竞态：断开撤销后，fetch 已完成的重同步仍会走完 swap，
 *   把指向死 client 的工具注册回来。revoke() 使代失效：未开始的同步直接跳过，
 *   在途同步完成后其结果交给 disposeResult 回收、绝不 commit。
 */

export interface SyncQueueOptions<T> {
  /** 一次同步：读取当前持有状态、执行、返回新结果。由队列保证串行执行，绝不并发。 */
  sync: () => Promise<T>
  /** 同步成功且代仍有效时提交结果（更新外部持有）。 */
  commit: (result: T) => void
  /** 同步完成后代已失效时回收结果（如撤销刚注册的工具，死工具不回流）。 */
  disposeResult: (result: T) => void
}

export interface SyncQueue<T> {
  /** 入队一次同步；resolve = 该次尝试已结算（被跳过也算结算）；sync 抛错则 reject。 */
  enqueue(): Promise<void>
  /** 使当前代失效：未开始的同步跳过；在途同步完成后其结果被回收、不提交。 */
  revoke(): void
}

export function createSyncQueue<T>(options: SyncQueueOptions<T>): SyncQueue<T> {
  let generation = 0
  let tail: Promise<void> = Promise.resolve()

  return {
    enqueue() {
      // 入队时捕获所属代：执行前代已失效则整个跳过（连接断开会撤销持有，无需再同步）
      const gen = generation
      const run = tail.then(async () => {
        if (gen !== generation) return
        const result = await options.sync()
        if (gen !== generation) {
          // 同步期间连接断开：回收刚拿到的一代，不 commit
          options.disposeResult(result)
          return
        }
        options.commit(result)
      })
      // 单次失败不阻断队列：链尾吞掉 rejection，后面的同步照常执行
      tail = run.catch(() => {})
      return run
    },
    revoke() {
      generation++
    },
  }
}
