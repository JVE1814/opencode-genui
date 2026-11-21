/** Largest data: image a spec may embed, in characters of the URL. */
export const MAX_DATA_IMAGE = 2_000_000

/**
 * The data: images a spec may embed: raster formats only. An SVG image is drawn on the window's main thread, and a few
 * hundred bytes of nested `<use>` elements draw 2^n shapes (18 levels froze the window for 43 s), while a data: image
 * shows without a click. Raster images decode off the main thread, at the size they show.
 */
const DATA_IMAGE = /^data:image\/(png|jpeg|jpg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i

/** A URL's scheme and its colon, as the URL parser reads one (an ASCII letter, then letters, digits, `+`, `-`, `.`). */
const SCHEME = /^[a-z][a-z\d+.-]*:/i

/**
 * The URL policy for model-written specs. Links may be http, https or mailto; images may be http(s) or a base64
 * data:image of a raster format. Everything else (javascript:, file:, relative paths, SVG and other data: types) is
 * refused with `undefined`.
 */
export function safeUrl(url: unknown, kind: "link" | "image"): string | undefined {
  if (typeof url !== "string") return undefined
  const trimmed = url.trim()
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined

  if (kind === "image" && trimmed.toLowerCase().startsWith("data:")) {
    return trimmed.length <= MAX_DATA_IMAGE && DATA_IMAGE.test(trimmed) ? trimmed : undefined
  }

  // Without a base, `new URL` throws for anything that does not start with a scheme: refused here without the
  // exception, which costs microseconds (more with DevTools open), and a Markdown text can hold 100,000 relative links.
  if (!SCHEME.test(trimmed)) return undefined
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }
  const allowed = kind === "link" ? ["http:", "https:", "mailto:"] : ["http:", "https:"]
  if (!allowed.includes(parsed.protocol)) return undefined
  if (parsed.protocol !== "mailto:" && !parsed.hostname) return undefined
  return parsed.href
}

/** Whether an image URL loads from the network (and so may wait for the user's click, per settings). */
export const isRemoteImage = (url: string) => /^https?:/i.test(url)

/** The host part of a URL, for confirmations ("Open example.com?"). */
export function urlHost(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "mailto:" ? parsed.pathname : parsed.host
  } catch {
    return url
  }
}
