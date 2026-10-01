// What DeepFilterNet's wasm-bindgen glue (deepfilter/df.js) needs that an AudioWorklet's
// scope lacks: TextDecoder/TextEncoder (made at load; only for error messages) and
// crypto.getRandomValues (getrandom, for hash table seeds inside the model runtime: nothing
// secret, so Math.random will do). Imported before the glue.
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class {
    decode(bytes) {
      if (!bytes) return '';
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer ?? bytes);
      let out = '';
      for (let i = 0; i < u8.length; i++) out += String.fromCharCode(u8[i]);
      return out;
    }
  };
}
if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = class {
    encode(text = '') {
      const out = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
      return out;
    }
    encodeInto(text, into) {
      const bytes = this.encode(text);
      into.set(bytes.subarray(0, into.length));
      return { read: text.length, written: Math.min(bytes.length, into.length) };
    }
  };
}
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = {
    getRandomValues(array) {
      for (let i = 0; i < array.length; i++) array[i] = Math.floor(Math.random() * 256);
      return array;
    },
  };
}
