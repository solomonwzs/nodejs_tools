# AGENTS.md - Node.js Tools Project

This file provides guidance to CodeBuddy Code when working with code in this repository.

## Project Overview

This is a TypeScript tools collection project using esbuild for bundling. Each tool is self-contained in its own directory under `src/`. The project has zero runtime dependencies — all tools use only Node.js built-in modules and `devDependencies`.

## Tech Stack

- **Language**: TypeScript (strict mode, ES2022 target)
- **Build Tool**: esbuild (ESM format, Node 18 platform target)
- **Module System**: ESM (ES Modules)
- **Runtime**: Node.js 18+

## Existing Tools

| Tool | Description |
|------|-------------|
| `helloworld` | Minimal template/scaffold tool |
| `adamsproxy` | OpenAI-compatible API reverse proxy. Routes `/v1/chat/completions` requests to different backends based on model name in the JSON body. Config read from `~/.config/adamsproxy.json` or CLI arg. Exposes `/$/models_info` endpoint. Supports per-model HTTP proxy and custom headers. |

## Project Structure

```
nodejs_tools/
├── src/
│   └── $tool/           # Each tool has its own directory
│       ├── index.ts     # Tool entry point
│       └── esbuild.js   # Build script for this tool
├── dist/                # Build output (gitignored)
│   └── $tool/
│       └── index.js
├── package.json         # Shared dependencies
├── tsconfig.json        # TypeScript configuration
└── AGENTS.md           # This file
```

## Commands

```sh
npm install              # Install dependencies
npm run build_$tool      # Build a specific tool (e.g., npm run build_adamsproxy)
```

There are no lint, test, or type-check scripts configured.

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
  external: [], // Add runtime dependencies here (e.g., ['express'])
})
```

Note: `external` must list any npm runtime dependencies so they are not bundled. Currently no tools have external runtime dependencies.

## Code Conventions

- Use TypeScript strict mode
- Use ESM imports/exports (`import`/`export`, not `require`)
- Entry point for each tool should be `index.ts`
- Output goes to `dist/$tool/`
- Tools may read user config from `~/.config/$tool.json`

## Notes

- All tools share `package.json` and `node_modules`
- Each tool builds independently with its own esbuild configuration
- The project uses Node.js native ESM support (`"type": "module"` in package.json)
- tsconfig compiles to ES2022; esbuild targets Node 18 — these are independent settings
