/**
 * Runs `callback` in a later task, after the current task and its microtasks: the browser handles input and paints
 * in between. Used to tell one task's work from the next one's (see ./budget.ts and the edit groups in ./state.ts).
 */
export function afterTask(callback: () => void): void {
  setTimeout(callback, 0)
}
