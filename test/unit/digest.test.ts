import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { contentId, sha256 } from "../../src/protocol/digest.ts"

describe("sha256", () => {
  test("matches the standard test vectors", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    )
  })

  test("agrees with node's crypto across padding boundaries and non-ASCII text", () => {
    const texts = [
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(64),
      "a".repeat(119),
      "héllo 世界 ✅ \u{1F600}",
      "x".repeat(10_007),
    ]
    for (const text of texts) expect(sha256(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"))
  })

  test("contentId is the first 128 bits, the same for the same text", () => {
    expect(contentId("abc")).toBe("ba7816bf8f01cfea414140de5dae2223")
    expect(contentId("abc")).toBe(contentId("abc"))
    expect(contentId("abd")).not.toBe(contentId("abc"))
  })
})
