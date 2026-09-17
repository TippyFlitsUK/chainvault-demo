// Streams the raw UnixFS leaf payloads out of a CARv1 in CAR order. For the CARs filecoin-pin produces
// (raw leaves, 1 MiB chunks, DFS order) that is exactly the original file's bytes in order.
const { Transform } = require('stream');

class CarLeaves extends Transform {
  constructor() {
    super();
    this.buf = Buffer.alloc(0);
    this.headerDone = false;
    this.block = null; // { remaining, raw } while a block's payload is being streamed
  }
  _readVarint(buf, off) {
    let r = 0n, shift = 0n, i = off;
    while (i < buf.length) {
      const b = buf[i++];
      r |= BigInt(b & 0x7f) << shift; shift += 7n;
      if (!(b & 0x80)) return [Number(r), i];
      if (shift > 63n) throw new Error('varint too long');
    }
    return null;
  }
  _transform(chunk, _enc, cb) {
    try {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      for (;;) {
        if (this.block) {
          const take = Math.min(this.block.remaining, this.buf.length);
          if (take === 0) break;
          if (this.block.raw) this.push(this.buf.subarray(0, take));
          this.buf = this.buf.subarray(take); this.block.remaining -= take;
          if (this.block.remaining === 0) this.block = null;
          continue;
        }
        if (!this.headerDone) {
          const v = this._readVarint(this.buf, 0); if (!v) break;
          const [len, off] = v; if (this.buf.length < off + len) break;
          this.buf = this.buf.subarray(off + len); this.headerDone = true; continue;
        }
        const v = this._readVarint(this.buf, 0); if (!v) break;
        const [blockLen, off] = v;
        // CID: v1 = version, codec, mh code, mh len, digest; v0 = 0x12 0x20 + 32-byte digest
        let p = off, codec;
        if (this.buf[p] === 0x12) { codec = 0x70; if (this.buf.length < p + 34) break; p += 34; }
        else {
          const a = this._readVarint(this.buf, p); if (!a) break; p = a[1];
          const c = this._readVarint(this.buf, p); if (!c) break; codec = c[0]; p = c[1];
          const m = this._readVarint(this.buf, p); if (!m) break; p = m[1];
          const l = this._readVarint(this.buf, p); if (!l) break; p = l[1] + l[0];
          if (this.buf.length < p) break;
        }
        const cidLen = p - off;
        this.buf = this.buf.subarray(p);
        this.block = { remaining: blockLen - cidLen, raw: codec === 0x55 };
      }
      cb();
    } catch (e) { cb(e); }
  }
}
module.exports = { CarLeaves };
