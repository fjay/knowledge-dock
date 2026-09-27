# knowledge-dock 部署指南

---

## 规划宿主机持久化目录

为了确保容器重启、镜像重建后数据与检查点打卡记录不丢失，所有持久化数据统一收敛在宿主机环境变量 `KNOWLEDGE_DATA_DIR`（默认为 `/data/knowledge`）所指定的目录下。

在宿主机终端执行以下命令创建标准持久化目录：

```bash
mkdir -p /data/knowledge/{state,workspace,inbox,config,certs,logs,remotes}
```

各子目录具体存放内容说明：
- 状态库目录 `state/`：挂载至容器 `/root/.actiondock`。存放检查点数据库（`global.db`）与容器专用的已知主机指纹文件（`known_hosts`）。这是核心命根子，万一丢失会导致系统忘记打卡进度，把所有仓库当成首次接入而从头全量建库。
- 工作区目录 `workspace/`：挂载至容器 `/srv/workspace`。存放所有纳管的业务代码仓与系统知识仓。
- 待审池目录 `inbox/`：挂载至容器 `/srv/knowledge-inbox`。存放外部投递的排障踩坑经验候选文件，与正式知识库物理隔离。
- 配置文件目录 `config/`：挂载至容器 `/etc/actiondock`。存放多仓库清单文件 `repos.json`。
- 可选证书目录 `certs/`：挂载至容器 `/etc/actiondock/certs:ro`。用于放置正式的 TLS 商业证书（`cert.pem` 与 `key.pem`）。若留空，服务启动时会自动生成高强度自签名证书。
- 日志目录 `logs/`：挂载至容器 `/var/log/actiondock`。存放服务前台访问日志与维护执行日志。
- 本地演练裸仓目录 `remotes/`：挂载至容器 `/data/knowledge/remotes`。存放本地演练或离线测试用的 Git 裸仓。

---

## 配置环境变量与安全规则

复制环境配置模板并生成高强度随机令牌：

```bash
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

编辑 `.env` 文件，填入生成的随机字符串与本地路径：

```dotenv
# 查询视图令牌 (面向外部用户与业务助手，仅能只读查搜与投递经验)
ACTIONDOCK_TOKEN=e1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2

# 特权维护视图令牌 (面向维护智能体与调度器，具备文件编辑与打卡权限)
ACTIONDOCK_AGENT_TOKEN=f2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3

# 服务对外监听端口 (默认为 443)
PORT=443

# 宿主机持久化根目录
KNOWLEDGE_DATA_DIR=/data/knowledge

# 宿主机 SSH 密钥目录
SSH_DIR=/root/.ssh

# Git 提交身份标识
GIT_AUTHOR_NAME="Knowledge Maintainer"
GIT_AUTHOR_EMAIL="maintainer@actiondock.local"
```

配置安全约束说明：
- 为什么两个令牌必须分开且足够长：查询令牌与特权维护令牌权限完全不同。启动脚本内含硬性安全校验：两个令牌均必须配置、长度必须达到 32 字符以上、两者严禁相同，且不能包含诸如 `changeme` 等测试占位词，否则直接拒绝启动。
- 为什么挂载私钥和已知主机文件：宿主机私钥目录以只读方式（`:ro`）挂载进容器，让容器能免密拉取与推送 Git 分支，同时杜绝容器篡改私钥；已知主机指纹文件 `known_hosts` 则指向可写的持久化目录 `state/`，容器首次连接新 Git 平台自动记录指纹，宿主机重启不丢，且绝不污染宿主机原本的指纹文件。

---

## 配置纳管仓库清单（repos.json）

在 `/data/knowledge/config/repos.json` 文件中配置需要维护的代码仓列表：

```json
[
  {
    "path": "/srv/workspace/order-service",
    "url": "git@github.com:example/order-service.git",
    "repoType": "code",
    "sourceBranch": "release",
    "knowledgeBranch": "docs"
  },
  {
    "path": "/srv/workspace/system-knowledge",
    "url": "git@github.com:example/system-knowledge.git",
    "repoType": "system_knowledge",
    "sourceBranch": "master"
  }
]
```

核心字段说明：
- 路径 `path`：容器内工作区绝对路径，统一以 `/srv/workspace/` 为前缀。
- 克隆地址 `url`：远端 Git 仓库地址。首次同步时若目录为空将自动克隆。
- 治理类型 `repoType`：`code` 为业务代码仓，采用双分支隔离模型；`system_knowledge` 为全局系统知识仓，采用单分支直接更新模型。
- 主干分支 `sourceBranch`：研发代码主分支（如 `release`、`main` 或 `master`）。
- 知识分支 `knowledgeBranch`：专门承载知识文档的分支（通常命名为 `docs`，仅 `code` 类型必需）。

---

## 启动容器与状态检查

构建镜像并启动容器服务：

```bash
docker compose up -d --build
```

查看容器运行状态：

```bash
docker compose ps
```

查看实时启动日志：

```bash
docker compose logs -f knowledge-server
```

日志中打印单端口多视图就绪信息后，表明 443 端口已正常对外提供服务。

---

## 客户端配置与功能验证

在客户端执行机登记连接配置并验证功能：

```bash
# 登记面向外部用户与查询助手的只读查询配置 (sk)
ad profile add sk -s https://<cloud-host-ip>:443 -t <ACTIONDOCK_TOKEN> -k -d "知识中枢只读查询服务"

# 登记面向维护智能体的特权维护配置 (skm)
ad profile add skm -s https://<cloud-host-ip>:443 -t <ACTIONDOCK_AGENT_TOKEN> -k -d "知识中枢特权维护服务"
```

验证全文检索与经验投递：

```bash
# 验证代码与文档全文正则检索
ad run workspace/search.rg --profile sk -- pattern="OrderController"

# 验证排障踩坑经验投递入待审池
ad run knowledge/knowledge.collect --profile sk -- title="超时重试排障" content="遇到超时需开启指数退避重试..."
```

验证权限安全隔离（反向测试）：

```bash
# 在普通查询配置下尝试调用写操作，命令将直接被白名单拦截并报错
ad run workspace/files.write --profile sk -- path="order-service/test.md" content="hack"
```

---

## 常见排障速查

- 连不上 443 端口：
  - 检查宿主机防火墙是否放行 443 端口；
  - 检查云服务器控制台的安全组规则，确认允许来源 IP 访问 TCP 443 端口；
  - 若宿主机 443 端口已被占用，可在 `.env` 中修改为 `PORT=8443`，并执行 `docker compose up -d` 重新映射。
- Git 同步报错权限不足：
  - 检查宿主机私钥文件权限是否为 600（`chmod 600 /root/.ssh/id_rsa`）；
  - 进入容器测试握手：`docker compose exec knowledge-server ssh -T git@<git-host>`；
  - 确认该私钥在代码托管平台拥有对应仓库的推送写入权限。
- 客户端提示证书不受信任：
  - 若使用自动生成的自签名证书，ActionDock 命令行在注册或调用时必须附加 `-k` 选项跳过证书校验；
  - 若使用企业正式证书，将 `cert.pem` 与 `key.pem` 放置在宿主机 `$KNOWLEDGE_DATA_DIR/certs/` 目录下，并执行 `docker compose restart knowledge-server` 重启生效。
- 容器启动后立刻退出：
  - 查看日志：`docker compose logs knowledge-server`；
  - 检查 `.env` 文件中的两个令牌是否均已设置、互不相同、长度均达到 32 字符以上，且未包含默认占位符。
- 双分支合并出现冲突导致同步中止：
  - 进入容器工作区执行 `git status`；
  - 排查是否在知识分支误改了主干业务代码文件；使用 `git merge --abort` 放弃合并恢复初始状态，交由智能体语义消解。
