/**
 * Waits until json-render has no evaluation of props or `visible` waiting for a later task: past a task's slice, the
 * elements left are evaluated in the next tasks (see `evaluationsWaiting` in patches/@json-render%2Fsolid). The test
 * file has imported @json-render/solid already (after stubbing the DOM), so this import finds it loaded.
 */
export async function evaluationsDone(): Promise<void> {
  const solid = (await import("@json-render/solid")) as { readonly evaluationsWaiting?: () => boolean }
  for (let task = 0; task < 1000 && solid.evaluationsWaiting?.(); task++)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
}
