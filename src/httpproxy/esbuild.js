import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/httpproxy/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/httpproxy/index.js',
  external: [],
})
