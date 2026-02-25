# AGENTS.md - Node.js Tools Project

## Project Overview

This is a TypeScript tools collection project using esbuild for bundling. Each tool is self-contained in its own directory under `src/`.

## Tech Stack

- **Language**: TypeScript
- **Build Tool**: esbuild
- **Module System**: ESM (ES Modules)

## Project Structure

```
nodejs_tools/
├── src/
│   └── $tool/           # Each tool has its own directory
│       ├── index.ts     # Tool entry point
│       └── esbuild.js   # Build script for this tool
├── package.json         # Shared dependencies
├── tsconfig.json        # TypeScript configuration
└── AGENTS.md           # This file
```

## Commands

### Install Dependencies
```sh
npm install
```

### Build a Tool
```sh
npm run build_$tool
```
Each tool requires:
1. A directory at `src/$tool/`
2. An `esbuild.js` file in that directory
3. A corresponding script entry in `package.json`

### Adding a New Tool

1. Create directory: `src/$tool/`
2. Add source files (e.g., `index.ts`)
3. Create `src/$tool/esbuild.js` with build configuration
4. Add script to `package.json`:
   ```json
   "scripts": {
     "build_$tool": "node src/$tool/esbuild.js"
   }
   ```

## esbuild.js Template

```javascript
import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/$tool/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/$tool/index.js',
  external: [], // Add external dependencies here
})
```

## Code Conventions

- Use TypeScript strict mode
- Use ESM imports/exports (`import`/`export`, not `require`)
- Entry point for each tool should be `index.ts`
- Output goes to `dist/$tool/`

## Notes

- All tools share `package.json` and `node_modules`
- Each tool builds independently with its own esbuild configuration
- The project uses Node.js native ESM support
