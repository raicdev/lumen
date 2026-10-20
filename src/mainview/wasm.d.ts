/** esbuild's binary loader turns `.wasm` imports into their bytes. */
declare module "*.wasm" {
  const bytes: Uint8Array;
  export default bytes;
}
