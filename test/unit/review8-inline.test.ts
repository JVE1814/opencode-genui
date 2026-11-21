import { beforeEach, describe, expect, test } from "bun:test"
import { createComputed, createRoot } from "solid-js"
import {
  defer,
  HOST_MOUNT_MS,
  inlineMembers,
  joinInlinePool,
  MOUNT_TEXT_PER_UNIT,
  MOUNT_UNITS,
  mountUnits,
  POOL_SURFACES,
  sliceAllows,
  sliceMount,
  spend,
  TASK_MS,
  TASK_UNITS,
  waiting,
  windowPool,
  type Waiter,
} from "../../src/runtime/budget.ts"
import { RENDER_UNITS } from "../../src/shared/constants.ts"

// Regression tests for the eighth review's finding R7S2-3 ([review8#R7S2-3]): mounting many surfaces at once (one
// message of 1,700 small blocks, or a session reopened) counts in the window's per-task slice, and the newest inline
// surface is crowned in constant time. test/e2e/review8-inline.spec.ts measures the same in the playground.

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** Lets the window's queue run dry (what earlier tests left waiting). */
async function drain() {
  for (let task = 0; task < 2000 && waiting() > 0; task++) await nextTask()
}

beforeEach(drain)

describe("the newest inline surface is crowned in constant time [review8#R7S2-3]", () => {
  test("joining and leaving touch only the members involved: 40,000 surfaces join and leave in well under a second", () => {
    // Before: each join set the flag of every member (and each leave searched the list, then set them all again):
    // 40,000 joins were 800 million flag writes, seconds of a frozen window for one session's worth of small blocks.
    const started = performance.now()
    const members = Array.from({ length: 40_000 }, () => joinInlinePool())
    expect(inlineMembers()).toBe(40_000)
    for (const member of members) member.leave()
    expect(inlineMembers()).toBe(0)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test("the last surface to join is the newest; when it leaves, the one before it is again", () => {
    const shared = [windowPool("inline")]
    const [a, b, c] = [joinInlinePool(), joinInlinePool(), joinInlinePool()]
    const newest = () => [a, b, c].map((member) => member.meters().length === 1)
    expect(newest()).toEqual([false, false, true])
    expect(c.meters()).toEqual(shared)
    expect(a.meters()[1]!.maxUnits).toBe((POOL_SURFACES.inline - 1) * RENDER_UNITS)
    // A member in the middle leaving changes nothing for the others.
    b.leave()
    expect(newest()).toEqual([false, false, true])
    c.leave()
    expect(a.meters()).toEqual(shared)
    // Leaving twice is harmless, and a new member is the newest again.
    c.leave()
    b.leave()
    const d = joinInlinePool()
    expect([a.meters().length, d.meters().length]).toEqual([2, 1])
    d.leave()
    expect(a.meters().length).toBe(1)
    a.leave()
    expect(inlineMembers()).toBe(0)
  })

  test("a member's meters follow its flag reactively, and each join or leave changes at most two of them", () => {
    createRoot((dispose) => {
      const members = Array.from({ length: 50 }, () => joinInlinePool())
      const changes = members.map(() => 0)
      const seen = members.map((member) => member.meters())
      const recount = () =>
        members.forEach((member, index) => {
          if (member.meters() !== seen[index]) {
            seen[index] = member.meters()
            changes[index]!++
          }
        })
      const extra = joinInlinePool()
      recount()
      // Only the previous newest changed: it now charges the older share too.
      expect(changes.reduce((sum, count) => sum + count, 0)).toBe(1)
      expect(changes[49]).toBe(1)
      extra.leave()
      recount()
      expect(changes[49]).toBe(2)
      expect(changes.slice(0, 49).every((count) => count === 0)).toBe(true)
      for (const member of members) member.leave()
      dispose()
    })
  })
})

describe("mounting a surface counts in the task's slice [review8#R7S2-3]", () => {
  test("what a surface costs: MOUNT_UNITS, plus a unit for every MOUNT_TEXT_PER_UNIT characters of its block", () => {
    expect(mountUnits(0)).toBe(MOUNT_UNITS)
    expect(mountUnits(MOUNT_TEXT_PER_UNIT - 1)).toBe(MOUNT_UNITS)
    expect(mountUnits(100_000)).toBe(MOUNT_UNITS + Math.floor(100_000 / MOUNT_TEXT_PER_UNIT))
    // A block of 100 KB costs about half a slice to compile; a slice mounts about 100 small surfaces.
    expect(mountUnits(100_000)).toBeLessThan(TASK_UNITS)
    expect(Math.ceil(TASK_UNITS / mountUnits(60))).toBe(100)
  })

  test("1,700 surfaces asked for in one task mount at most a slice's worth per task, all of them, in order", async () => {
    const order: number[] = []
    const perTask: number[] = []
    const roots = Array.from({ length: 1700 }, (_, index) =>
      createRoot((dispose) => {
        const mounted = sliceMount(mountUnits(60))
        // Each surface records when it mounts (a computation of its own, as the surface's Show).
        createComputed(() => {
          if (mounted()) order.push(index)
        })
        return dispose
      }),
    )
    // The first task mounts at most a slice's worth (and always at least one).
    perTask.push(order.length)
    expect(order.length).toBeGreaterThan(0)
    expect(order.length).toBeLessThanOrEqual(TASK_UNITS / mountUnits(60) + 1)
    expect(waiting()).toBe(1700 - order.length)
    for (let task = 0; task < 500 && order.length < 1700; task++) {
      const before = order.length
      await nextTask()
      perTask.push(order.length - before)
    }
    expect(order).toEqual(Array.from({ length: 1700 }, (_, index) => index))
    // A task mounts at most a slice's worth: each surface checks the slice as it wakes.
    expect(Math.max(...perTask)).toBeLessThanOrEqual(Math.ceil(TASK_UNITS / mountUnits(60)))
    expect(perTask.length).toBeGreaterThan(10)
    for (const dispose of roots) dispose()
  })

  test("in a task of the app's, surfaces mount for HOST_MOUNT_MS; in the window's own tasks, for TASK_MS", async () => {
    // Each surface here takes 20 ms to mount. The task that asks for them is the app's (its Markdown came first, which
    // the slice does not see): it mounts them for HOST_MOUNT_MS. The window's own tasks hold nothing else: TASK_MS.
    const busy = (ms: number) => {
      const end = performance.now() + ms
      while (performance.now() < end) {}
    }
    const perTask: number[] = [0]
    const roots = Array.from({ length: 30 }, () =>
      createRoot((dispose) => {
        const mounted = sliceMount(MOUNT_UNITS)
        createComputed(() => {
          if (!mounted()) return
          perTask[perTask.length - 1]!++
          busy(20)
        })
        return dispose
      }),
    )
    for (let task = 0; task < 100 && perTask.reduce((sum, count) => sum + count, 0) < 30; task++) {
      perTask.push(0)
      await nextTask()
    }
    expect(perTask[0]).toBeGreaterThan(0)
    expect(perTask[0]).toBeLessThanOrEqual(Math.ceil(HOST_MOUNT_MS / 20))
    expect(Math.max(...perTask.slice(1))).toBeGreaterThan(Math.ceil(HOST_MOUNT_MS / 20))
    expect(Math.max(...perTask.slice(1))).toBeLessThanOrEqual(Math.ceil(TASK_MS / 20))
    for (const dispose of roots) dispose()
  })

  test("a surface that goes away before its turn never mounts, and does not hold up the ones after it", async () => {
    spend(TASK_UNITS)
    expect(sliceAllows()).toBe(false)
    const mounts: string[] = []
    const make = (name: string) =>
      createRoot((dispose) => {
        const mounted = sliceMount(MOUNT_UNITS)
        createComputed(() => {
          if (mounted()) mounts.push(name)
        })
        return dispose
      })
    const first = make("first")
    make("second")
    expect(mounts).toEqual([])
    first()
    await drain()
    expect(mounts).toEqual(["second"])
  })

  test("what a woken surface finds deferred again goes before the rest of the queue, so the window fills in order", async () => {
    // Waiters that each fill the slice when woken, and leave a child (their elements) waiting for the next task.
    const log: string[] = []
    const waiter = (name: string, child?: () => Waiter): Waiter => {
      const self: Waiter = {
        queued: false,
        disposed: false,
        wake: () => {
          if (!sliceAllows()) return defer(self)
          log.push(name)
          spend(TASK_UNITS)
          if (child) defer(child())
        },
      }
      return self
    }
    spend(TASK_UNITS)
    for (let index = 0; index < 4; index++) defer(waiter(`s${index}`, () => waiter(`s${index}.child`)))
    await drain()
    // Before: every child waited until all surfaces queued after its own had mounted.
    expect(log).toEqual(["s0", "s0.child", "s1", "s1.child", "s2", "s2.child", "s3", "s3.child"])
  })
})
