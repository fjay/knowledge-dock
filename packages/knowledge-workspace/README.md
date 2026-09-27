# ActionDock Workspace

面向智能体的工程工作区能力包，基于 [ActionDock](https://github.com/team4u/actiondock) 规范构建，提供高吞吐结构化 ripgrep 检索、受控分段文本读取、受限目录浏览、文件写入与局部受控编辑能力。

## 核心定位与设计原则

- **工作区沙箱安全隔离**：Shell 执行与文件操作严格收敛在工作区根目录内部，命令工作目录不可越界，对外只读由查询视图动作白名单实现。
- **真实 ripgrep 原生语义**：参数直接映射 ripgrep 长参数规范，消除额外抽象层，保持智能体认知一致性。
- **逻辑路径绝对隔离**：所有返回路径均归一化为相对于工作区根目录的相对路径，彻底隐藏宿主机物理文件路径。
- **多层防护拦截**：内置符号链接逃逸校验、敏感凭据文件全局过滤与服务器硬限预算控制。
- **全平台自适应寻址**：纯 Node.js 实现文件浏览、读取、写入与编辑，全文检索支持环境变量覆盖、内置预编译程序探测与系统命令三级平滑降级。

## 核心动作列表

- **结构化全文检索**：`search.rg`（完全限定标识：`workspace/search.rg`）
  - 核心参数：`pattern`、`paths`、`maxResults`、`fixedStrings`、`ignoreCase`、`smartCase`、`glob`、`context`、`maxCount` 等。
  - 特性：流式解析 JSON Lines 事件流，支持匹配上下文合并，受限于服务端结果行数与字节预算。
- **分页文本读取**：`files.read`（完全限定标识：`workspace/files.read`）
  - 核心参数：`path`、`startLine`、`maxLines`。
  - 特性：流式跳行读取，仅支持 UTF-8 编码，自动标记后续截断状态 `hasMore`。
- **受控目录浏览**：`files.list`（完全限定标识：`workspace/files.list`）
  - 核心参数：`path`、`depth`、`hidden`。
  - 特性：目录优先排序，输出文件字节大小，默认屏蔽隐藏项与内部敏感文件。
- **文件安全写入**：`files.write`（完全限定标识：`workspace/files.write`）
  - 核心参数：`path`、`content`、`createDirs`、`overwrite`。
  - 特性：自动补齐父级目录，防越界与敏感文件拦截，支持全量覆盖与创建标记返回。
- **局部受控编辑**：`files.edit`（完全限定标识：`workspace/files.edit`）
  - 核心参数：`path`、`targetContent`、`replacementContent`、`allowMultiple`、`startLine`、`endLine`。
  - 特性：基于目标文本块精准匹配替换，支持行号区间收敛搜索，多重匹配冲突保护与编码一致性保障。
- **命令直接执行**：`bash.exec`（完全限定标识：`workspace/bash.exec`）
  - 核心参数：`command`、`cwd`、`timeoutMs`。
  - 特性：在工作区内直接执行原生终端与版本管理命令（如 `git status`、`git diff`、`git restore .`、`npm test`），执行结果直接映射为 `content` 原生终端输出流，退出码独立输出至 stderr，兼顾原生体验与自动化消费。
- **链接引用校验**：`links.verify`（完全限定标识：`workspace/links.verify`）
  - 核心参数：`path`、`checkAnchors`、`ignoreDirs`。
  - 特性：零外部依赖确定性扫描 Markdown 相对文件与文档内标题锚点，过滤网络链接并精确定位失效链接位置与原因。

## 工作区根目录与限定配置

所有 Action 操作的边界均严格限定在工作区根目录下：

- **未显式配置时的默认安全沙箱（禁止任意访问）**：
  - 未配置时，系统**绝不**意味着开放宿主机任意文件访问。
  - 根目录会自动**死死锁定在发起命令时所在的当前终端工作目录**。
  - 操作范围仅限于当前目录及其子目录内部，任何跨目录相对路径（如 `../`）、外部绝对路径（如 `/etc` 或其他项目目录）以及外部符号链接均会被坚决拦截并报错。
- **显式配置目标工作区**：可通过以下方式将操作范围跨目录锚定在指定的工程根目录：

### 配置方式 A：通过配置中心管理

```bash
# 设置全局工作区根目录
ad config set --global WORKSPACE_ROOT /path/to/target/project

# 检查当前配置项状态
ad config schema
```

### 配置方式 B：通过环境变量注入

```bash
# 当前终端会话全局生效
export WORKSPACE_ROOT=/path/to/target/project

# 临时单次命令或启动 MCP 服务时指定（使用扁平参数）
WORKSPACE_ROOT=/srv/workspace ad run search.rg -- pattern=foo
WORKSPACE_ROOT=/srv/workspace ad mcp
```

### 限定目录的行为特性与安全保障

- **路径越界全面拦截**：无论使用绝对路径、携带 `../` 的相对路径，还是跳出工作区的符号链接，均会被强制拦截并返回错误代码 `PATH_OUTSIDE_WORKSPACE` 或 `SYMLINK_OUTSIDE_WORKSPACE`。
- **返回路径绝对保密**：所有动作返回的路径字段均为相对于 `WORKSPACE_ROOT` 的相对逻辑路径（例如 `src/index.ts`），绝不向模型或外部暴露宿主机物理绝对路径。
- **单次调用子范围精细收敛**：在工作区根目录确立的基础上，可在单次调用中通过参数进一步限定子范围：
  - 全文检索：通过 `paths` 数组限定只搜索某些子目录（例如 `{"paths":["src/services"]}`）。
  - 目录浏览：通过 `path` 字符串限定只查看特定子目录（例如 `{"path":"src/utils"}`）。
  - 文本读取：通过 `path` 字符串精确指向目标文件（例如 `{"path":"src/index.ts"}`）。

## 标准作业规程

包含标准排查探索与修改规程：`playbooks/inspect-workspace.md`。为智能体提供结构化的工作区代码排查与修改步骤，涵盖目录摸底、全文检索、分段精读、受控修改、断链自检以及原生终端审查回滚闭环。

## 安全与防护策略

- **工作区边界检查**：基于 `path.relative` 与真实路径二次核验，拦截任何尝试跳出工作区根目录的相对路径与跨界软链接。
- **敏感文件黑白名单**：全局阻断 `.git/**`、`**/.env`、`**/*.pem`、`**/id_rsa` 等机密配置，安全放行 `.env.example` 与模板说明。
- **服务器硬限预算**：
  - 检索执行超时：15000 毫秒
  - 最大检索返回数：200 条
  - 单行最大匹配字节：4096 字节
  - 检索输出总预算：4 MB
  - 单次读取最大行数：5000 行（默认 2000 行）
  - 单次读取最大字节：1 MB
  - 最大遍历深度：10 层
  - 最大目录枚举数：1000 项

## 快速上手与运行

### 依赖安装与开发环境准备

- **克隆源码开发测试**：
  克隆源码参与开发测试时，若系统全局配置了 `omit=dev` 导致开发依赖被忽略，请显式指定安装开发依赖：
  ```bash
  npm install --include=dev
  ```

### 本地测试与类型检查

```bash
# 执行自动化单元测试与集成测试
npm test

# 执行 TypeScript 全量编译检查
npm run typecheck
```

### 命令行调试调用

#### 扁平参数调用（推荐调用方式，杜绝终端引号与转义问题）

根据 ActionDock 规范，面向智能体与命令行的推荐语法为扁平参数赋值（`ad run <action> [control-options] [-- <assignments...>]`）：
- 控制选项与数据参数通过 `--` 协议边界隔离；
- `path=value` 严格保留为字符串；
- `path:=json` 严格解析为 JSON；
- 数组索引支持点号连续编号（如 `paths.0=src`）或 JSON 数组（`paths:='["src"]'`）。

```bash
# 全局软链注册当前包（只需在开发机执行一次）
ad link .

# 直接调用动作（扁平化参数）
ad run search.rg -- pattern=WorkspacePathPolicy paths.0=src
ad run files.read -- path=src/limits.ts startLine:=1 maxLines:=20
ad run files.list -- path=src depth:=1
ad run files.write -- path=notes/task.md content="待办事项清单"
ad run files.edit -- path=notes/task.md targetContent="清单" replacementContent="汇总"
ad run links.verify -- path=notes
ad run bash.exec -- command="git status"

# 带包限定前缀与 --json 机器模式输出调用
ad run workspace/search.rg --json -- pattern=WorkspacePathPolicy paths.0=src
ad run workspace/files.read --json -- path=src/limits.ts startLine:=1 maxLines:=20
ad run workspace/files.list --json -- path=src depth:=1
ad run workspace/files.write --json -- path=notes/task.md content="待办事项清单"
ad run workspace/files.edit --json -- path=notes/task.md targetContent="清单" replacementContent="汇总"
ad run workspace/links.verify --json -- path=notes
ad run workspace/bash.exec --json -- command="git status"
```

#### 内联 JSON 调用（与扁平参数互斥）

```bash
ad run search.rg --input '{"pattern":"WorkspacePathPolicy","paths":["src"]}'
ad run files.read --input '{"path":"src/limits.ts","startLine":1,"maxLines":20}'
ad run files.list --input '{"path":"src","depth":1}'
ad run files.write --input '{"path":"notes/task.md","content":"待办事项清单"}'
ad run files.edit --input '{"path":"notes/task.md","targetContent":"清单","replacementContent":"汇总"}'
```

### 构建与独立分发

- **默认构建（依赖宿主环境）**：
  默认构建命令 `ad build` 生成的目录型交付产物依赖宿主环境中已具备的相应依赖：
  ```bash
  ad build -o dist/workspace-build
  ```
- **脱离项目独立分发（内联打包依赖）**：
  脱离项目独立分发或部署至离线环境时，需使用 `--vendor-deps` 参数将锁定的生产依赖物化内联打包至交付产物中：
  ```bash
  # 物化内联生产依赖并输出到交付目录
  ad build --vendor-deps -o dist/workspace-build

  # 亦可附带 --archive 参数直接生成压缩归档文件
  ad build --vendor-deps --archive -o dist/workspace.zip

  # 运行独立分发产物（扁平参数）
  node dist/workspace-build/entry.mjs run search.rg -- pattern=foo
  ```

## 工程目录结构

- `actiondock.json`：ActionDock 规范清单描述文件，声明输入输出模式、配置依赖与规程。
- `actions/`：核心动作处理函数入口定义。
- `src/`：底层共享安全策略、参数构建器、流式解析器与可执行文件解析器。
- `playbooks/`：标准作业规程定义文件。
- `tests/`：基于 Node.js 原生测试运行器与 `@actiondock/testing` 的完整测试套件。
