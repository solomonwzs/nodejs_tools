import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/gongfengproxy/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/gongfengproxy/index.js',
  external: [],
})
