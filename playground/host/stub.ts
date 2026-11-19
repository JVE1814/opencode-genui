/**
 * Wraps a partial implementation of a host API: members it has work; any other member path is a placeholder that
 * throws a clear error when called, so a plugin that reaches for something the playground does not fake fails loudly
 * instead of silently doing nothing. Reading a missing member does not throw (feature checks such as `if (x.y)` stay
 * cheap), but it is truthy, so prefer calling it.
 */
export function unimplemented<T extends object>(implemented: T, path: string): T {
  // One proxy per object, so a member read twice is the same value (callers key caches by them).
  const nested = new Map<string, object>()
  return new Proxy(implemented, {
    get(target, key, receiver) {
      if (typeof key === "symbol") return Reflect.get(target, key, receiver)
      if (key in target) {
        const value = Reflect.get(target, key, receiver) as unknown
        if (typeof value === "object" && value !== null && !Array.isArray(value) && Object.isExtensible(value)) {
          let wrapped = nested.get(key)
          if (!wrapped) {
            wrapped = unimplemented(value as object, `${path}.${key}`)
            nested.set(key, wrapped)
          }
          return wrapped
        }
        return value
      }
      if (key === "then" || key === "toJSON") return undefined
      return missing(`${path}.${key}`)
    },
  })
}

function missing(path: string): unknown {
  const fail = () => {
    throw new Error(`The genui playground does not implement ${path}`)
  }
  return new Proxy(fail, {
    get(_, key) {
      if (key === "then" || typeof key === "symbol") return undefined
      return missing(`${path}.${String(key)}`)
    },
    apply: fail,
    construct: fail,
  })
}

/** A function that throws the playground's "not implemented" error for one member. */
export const notImplemented =
  (path: string) =>
  (..._args: unknown[]): never => {
    throw new Error(`The genui playground does not implement ${path}`)
  }
