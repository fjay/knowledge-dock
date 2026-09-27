# 工程工作区探索与排查规程

本文档规范智能体在工程工作区内浏览目录、搜索代码、阅读文本、受控修改、断链校验与终端执行的标准操作规程。

## 工作区配置与范围限定

在执行任何探索与排查操作前，应明确工作区根目录边界：

- **未显式配置时的默认行为**：
  未配置时自动锁定为当前终端工作目录，绝不开放全盘任意文件夹访问。操作严格受限于当前工程目录内部，任何跨工程、跳出上层目录或系统绝对路径的访问均会被安全拦截。
- **全局配置中心方式**：
  使用 ActionDock 命令行工具配置全局工作区根目录：
  ```bash
  ad config set --global WORKSPACE_ROOT /path/to/target/project
  ```
- **环境变量注入方式**：
  在终端会话或启动服务时注入环境变量：
  ```bash
  export WORKSPACE_ROOT=/path/to/target/project
  # 或临时命令前缀指定（使用扁平参数）：
  WORKSPACE_ROOT=/srv/workspace ad run search.rg -- pattern=foo
  ```
- **沙箱约束说明**：
  配置生效后，所有后续 Action 调用均在该目录内闭环执行，返回的路径统一为相对逻辑路径，越界访问将被强制拦截。

## 标准排查与维护流程

智能体应遵循 **“目录摸底 -> 全文检索 -> 分段精读 -> 受控修改 -> 断链自检 -> 终端审查与回滚”** 的标准闭环步骤，严禁无序盲目遍历。

### 目录结构探索 (`files.list`)

优先获取工作区顶层目录结构，掌握工程整体骨架与核心模块划分。

- **调用原则**：优先以较浅深度（`depth=1` 或 `2`）扫描，避免深层全量遍历消耗大量上下文。
- **推荐调用示例（扁平参数）**：
  ```bash
  # 扫描工程根目录一级结构：
  ad run files.list -- path=. depth:=1

  # 深入特定源码目录二级结构：
  ad run files.list -- path=src depth:=2

  # 机器模式输出（JSON 信封）：
  ad run files.list --json -- path=src depth:=1
  ```

### 关键代码检索 (`search.rg`)

定位关键类名、函数定义、错误日志或配置项。利用 ripgrep 原生参数进行精准搜索。

- **调用原则**：
  - 先窄后宽：若已知目标模块，通过 `paths` 数组限定检索子目录（使用连续点号索引语法，如 `paths.0="src" paths.1="docs"`）；
  - 避免转义：包含特殊符号的代码片段使用 `fixedStrings:=true` 进行字面量精确匹配；
  - 上下文把控：需要观察调用上下文时配置 `context:=2`，必要时通过 `maxResults` 约束返回条数。
- **推荐调用示例（扁平参数）**：
  ```bash
  # 基础正则模式搜索：
  ad run search.rg -- pattern="WorkspacePathPolicy"

  # 限定多子目录与忽略大小写搜索（数组参数连续索引）：
  ad run search.rg -- pattern="payment" paths.0="src" paths.1="docs" ignoreCase:=true

  # 字面量精确匹配（无需正则转义，附带上下文行）：
  ad run search.rg -- pattern="defineAction<Input, Output>" fixedStrings:=true context:=2 maxResults:=20

  # 机器模式输出（JSON 信封）：
  ad run search.rg --json -- pattern="RG_TIMEOUT_MS" context:=1
  ```

### 源码分段精读 (`files.read`)

通过检索命中具体文件路径与行号后，按需阅读源文件内容。

- **调用原则**：
  - 严禁一次性全量加载超大文件；
  - 基于检索命中的行号，设定合理的 `startLine` 和 `maxLines`（建议单次 50 ~ 100 行）；
  - 关注返回的 `hasMore` 状态，若内容未完可连续翻页读取。
- **推荐调用示例（扁平参数）**：
  ```bash
  # 精确定位目标行附近代码（从第 1 行起读取 30 行）：
  ad run files.read -- path=src/limits.ts startLine:=1 maxLines:=30

  # 连续分页读取后续内容：
  ad run files.read -- path=src/limits.ts startLine:=31 maxLines:=30

  # 机器模式输出（JSON 信封）：
  ad run files.read --json -- path=package.json startLine:=1 maxLines:=20
  ```

### 受控修改与安全落盘 (`files.edit` 与 `files.write`)

对定位出的缺陷代码或待更新文档进行受控编辑，严禁使用盲目覆盖破坏原有逻辑。

- **调用原则**：
  - 修改已有代码或文档时，首选 `files.edit`，提供精准的原文本块与替换文本块；
  - 新建文档或配置时使用 `files.write`，自动按需创建缺失的父级目录。
- **推荐调用示例（扁平参数）**：
  ```bash
  # 精准局部替换已有文件内容：
  ad run files.edit -- path=docs/example.md targetContent="旧版本说明" replacementContent="新版本说明"

  # 安全写入新建文件（自动递归创建父目录）：
  ad run files.write -- path=docs/guide/start.md content="# 快速指引\n\n初始化内容..."
  ```

### 相对链接与锚点校验 (`links.verify`)

在对 Markdown 文档完成任何新增或编辑操作后，必须执行全自动死链扫描，确保知识库网状结构健康。

- **调用原则**：
  - 交付门禁：若返回存在断链（`brokenCount > 0`），必须就地结合 `brokenLinks` 清单自愈修复；
  - 校验范围：覆盖相对文件路径、本地图片资源以及文档内部标题锚点跳转。
- **推荐调用示例（扁平参数）**：
  ```bash
  # 校验全工作区 Markdown 链接与锚点：
  ad run links.verify -- path=.

  # 仅校验指定文档目录：
  ad run links.verify -- path=docs
  ```

### 原生终端执行与改动回滚 (`bash.exec`)

在维护平面直接执行原生终端命令，用于状态自检、差异核验、测试运行以及误改回滚。

- **调用原则**：
  - 原生终端体验：执行输出直接映射为 `content` 正文，默认模式下直接向 stdout 原始输出（保留真实换行且无 JSON 转义），退出码等元数据独立输出至 stderr，与原生终端行为一致；
  - 变更核验：提交文档前查看 `git status` 与 `git diff`，确保修改完全收敛于目标目录；
  - 误改回滚：若不慎修改了无关源码或生成临时文件，立即执行 `git restore .` 丢弃修改；
  - 验证构建：必要时执行 `npm test` 或运行构建命令确保工程无破坏。
- **推荐调用示例（扁平参数）**：
  ```bash
  # 查看工作区版本状态：
  ad run bash.exec -- command="git status"

  # 比对具体修改补丁：
  ad run bash.exec -- command="git diff"

  # 一键丢弃未提交的误操作修改（回滚）：
  ad run bash.exec -- command="git restore ."

  # 运行工程单元测试验证：
  ad run bash.exec -- command="npm test"
  ```

## 安全红线与注意事项

- **严格限定在沙箱内**：所有传参的 `path` 必须为相对路径，严禁使用 `../` 逃逸出工作区根目录（违者触发 `PATH_OUTSIDE_WORKSPACE`）。
- **敏感信息全局阻断**：严禁尝试读取 `.env`、`**/*.pem`、`.git/**` 等敏感机密凭据文件（违者触发 `SENSITIVE_PATH_DENIED`）。
- **传参规范与数组索引语法**：推荐使用扁平参数（`-- <assignments...>`），杜绝 JSON 嵌套转义：
  - 控制参数写在 `--` 之前，业务数据参数写在 `--` 之后。
  - 纯字符串使用 `=`（如 `path="src/index.ts"`、`pattern="order"`）。
  - 数值、布尔值与复杂类型使用 `:=`（如 `depth:=1`、`startLine:=10`、`ignoreCase:=true`）。
  - 数组参数必须使用从 0 开始的连续点号索引语法（如 `paths.0="src" paths.1="docs"`），或使用 `:=` 传入 JSON 数组（如 `paths:='["src", "docs"]'`）。
  - 扁平参数与 `--input`、`--input-file` 严格互斥，切勿混用。
- **排错自愈闭环**：修改文档后必须执行 `links.verify` 确保零死链，若发生误操作必须执行 `git restore .` 及时回滚恢复。
