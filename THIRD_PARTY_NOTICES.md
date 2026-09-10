# 第三方声明 / Third-party notices

## CodexApp 的来源 / Project ancestry

CodexApp fork 自 / is forked from [friuns2/codex-mobile](https://github.com/friuns2/codex-mobile), with earlier origins in [pavel-voronin/codex-web-local](https://github.com/pavel-voronin/codex-web-local).

原项目版权与 MIT 许可原文保留在根目录 [LICENSE](LICENSE)。本分支新增内容不移除原有署名。 / Original copyrights and the MIT license are retained in the root LICENSE; this fork does not remove original attribution.

## CLIProxyAPI

| 项目 / Field | 值 / Value |
| --- | --- |
| 上游 / Upstream | https://github.com/router-for-me/CLIProxyAPI |
| 版本 / Version | 7.2.152 |
| 源码提交 / Source commit | `c76dfd4e0edabab9000628b1560ab8ab379eadb8` |
| 发行资产 / Release asset | `CLIProxyAPI_7.2.152_linux_amd64_no-plugin.tar.gz` |
| 许可证 / License | MIT; [完整原文 / full text](resources/api-proxy/LICENSE) |
| 来源与摘要 / Source and checksums | [manifest.json](resources/api-proxy/manifest.json) |

上游版权行按原文保留，包括日期写法： / Upstream copyright lines are preserved verbatim, including the date spelling:

```text
Copyright (c) 2025-2005.9 Luis Pater
Copyright (c) 2025.9-present Router-For.ME
```

本项目以独立可执行组件集成 CLIProxyAPI，提供应用侧账号路由、key 管理、界面与网关适配。安装脚本获取固定版本预构建文件，不修改其二进制，校验压缩包与可执行文件 SHA-256，并在组件目录保留 LICENSE 和 manifest.json。 / CodexApp integrates CLIProxyAPI as a separate executable, adding application-side routing, key management, UI, and gateway adaptation. The installer obtains a pinned prebuilt binary without modifying it, verifies archive and executable SHA-256 hashes, and preserves LICENSE and manifest.json alongside it.

本次 GitHub 的 `codexapp-0.2.16.tgz` 不包含 CLIProxyAPI 二进制，包含本声明、许可证与来源清单。源码安装时可显式下载该组件。若另行分发包含组件的 Docker 镜像、部署目录或压缩包，须一并保留该组件的版权及完整 MIT 许可；现有组件安装与宿主发布脚本按此布局复制。 / The GitHub `codexapp-0.2.16.tgz` excludes the CLIProxyAPI binary but includes this notice, its license, and source manifest. Source users can install the component explicitly. Any Docker image, deployment directory, or archive redistributing the component must retain its copyright and full MIT notice; existing component installation and host release scripts preserve this layout.

MIT 许可允许使用、修改与分发，要求保留相应版权和许可声明，并按原文提供无担保条款。以随附完整许可为准。集成不表示 CLIProxyAPI 作者、OpenAI 或其他供应方为 CodexApp 背书，也不授予额外模型访问权限。 / MIT permits use, modification, and redistribution subject to retaining its copyright and permission notice, with the warranty disclaimer in the full license. The accompanying license governs. Integration implies no endorsement by CLIProxyAPI authors, OpenAI, or other providers, and grants no additional model access.

## 其他依赖 / Other dependencies

Vue、Vite、Express、xterm.js、node-pty 等依赖各自保留其许可证；直接依赖与固定解析版本见 [package.json](package.json) 和 [pnpm-lock.yaml](pnpm-lock.yaml)。这些包通过包管理器安装，本声明不替代其各自的许可证。 / Other dependencies retain their respective licenses. See package.json and pnpm-lock.yaml for direct dependencies and resolved versions; package managers install them separately. This notice does not replace their individual licenses.
