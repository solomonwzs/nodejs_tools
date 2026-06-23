import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/adamsproxy2/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/adamsproxy2/index.js',
  external: [],
})
