// Bounded, offset-based output collectors — matches the ctx.subprocess
// "reads are non-consuming" contract: independent readers see the same bytes.
export class Collector {
  #chunks = []
  #bytes = 0
  #maxBytes
  #lossy = false
  #text = null

  constructor(maxBytes) {
    this.#maxBytes = maxBytes
  }

  get lossy() { return this.#lossy }

  write(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.#text = null
    const room = this.#maxBytes - this.#bytes
    if (buf.length <= room) {
      this.#chunks.push(buf)
      this.#bytes += buf.length
      return
    }
    if (room > 0) {
      this.#chunks.push(buf.subarray(0, room))
      this.#bytes += room
    }
    this.#lossy = true
  }

  #string() {
    if (this.#text === null) this.#text = Buffer.concat(this.#chunks).toString('utf8')
    return this.#text
  }

  readFrom(fromByte) {
    const text = this.#string()
    const total = Buffer.byteLength(text)
    if (fromByte >= total) return { text: '', nextOffset: total, lossy: this.#lossy }
    // Offsets are byte offsets; slice by bytes then decode, so multi-byte
    // characters never split the returned window at the wrong place.
    const buf = Buffer.from(text)
    const slice = buf.subarray(fromByte).toString('utf8')
    return { text: slice, nextOffset: total, lossy: this.#lossy }
  }
}
