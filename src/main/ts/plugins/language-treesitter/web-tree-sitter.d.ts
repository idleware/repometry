// The published 0.27.2 declarations reference browser globals from their optional Emscripten and WASM APIs.
// Repometry calls Parser.init without an options object and loads grammars from bytes.
interface EmscriptenModule {
  locateFile?: (filename: string, directory: string) => string;
}

declare namespace WebAssembly {
  interface Module {}
}
