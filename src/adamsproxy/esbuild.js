import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/adamsproxy/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/adamsproxy/index.js',
  external: [],
})
