import { beforeEach } from "bun:test"

// Every test starts in a task of its own, as each interaction in the window does: bun runs synchronous tests one after
// another within one task, so the time slices that json-render's patches keep per task (see patches/) would otherwise
// be spent by the tests before.
beforeEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
