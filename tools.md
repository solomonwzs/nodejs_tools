# 项目描述

+ 工具栈：typescript，使用 esbuild 做构建工具
+ 这是一个工具包项目，代码在 `src` 目录下，`src` 下有子目录 `src/$tool` 表示对应的工具
+ 所有工具共用一个 `package.json` 文件，`src/$tool` 下有对应的 `esbuild.js` 文件用于构建当前目录中的工具
+ 使用以下命令来构建对应工具
```sh
npm run build_$tool
```
