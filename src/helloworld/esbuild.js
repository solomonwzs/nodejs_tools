import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/helloworld/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/helloworld/index.js',
})
