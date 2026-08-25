import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/tc-llmproxy/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/tc-llmproxy/index.js',
  external: [],
})
