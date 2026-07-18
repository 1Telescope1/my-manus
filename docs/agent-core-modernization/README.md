# Manus Agent 核心现代化工作区

本目录用于记录 Agent 核心现代化工作的总任务状态和单任务实施过程。架构设计继续由 [Agent 核心现代化 SDD](../agent-core-modernization-sdd.md) 维护；不要在任务日志中复制整套设计。

## 目录结构

```text
docs/agent-core-modernization/
├── README.md                 # 工作区入口和使用规则
├── TASKS.md                  # 总任务清单：待办、状态、依赖和验收
├── tasks/
│   ├── _template/            # 新任务工作目录模板
│   │   ├── README.md         # 任务首页、范围和当前状态
│   │   ├── worklog.md        # 按会话持续追加工作过程
│   │   └── evidence.md       # 验收、测试和完成证据
│   └── <TASK-ID>/            # 任务开始时才创建
│       ├── README.md
│       ├── worklog.md
│       └── evidence.md
```

## 信息归属

| 信息 | 唯一记录位置 |
| --- | --- |
| 目标架构、接口、状态机、设计约束 | `../agent-core-modernization-sdd.md` |
| 所有要做的事情、状态、依赖和验收标准 | `TASKS.md` |
| 单个任务的范围和当前状态 | `tasks/<TASK-ID>/README.md` |
| 单个任务的持续工作过程 | `tasks/<TASK-ID>/worklog.md` |
| 单个任务的测试和完成证据 | `tasks/<TASK-ID>/evidence.md` |
| 架构决策 ADR | SDD 的“架构决策记录”章节 |

同一信息只维护一份。任务日志可以链接 SDD 和代码，但不要复制大段设计；SDD 不再保存逐任务实施日志。

## 开始一个任务

1. 阅读 SDD 中与任务有关的设计章节和 ADR。
2. 在 [总任务清单](./TASKS.md) 中确认任务为 `ready`，且 Dependencies 均为 `done`。
3. 按 [任务目录模板](./tasks/_template/README.md) 创建 `tasks/<TASK-ID>/` 文件夹和三个基础文件。
4. 将总任务清单中的状态改为 `in_progress`，并把任务 ID 链接到任务目录的 `README.md`。
5. 在任务目录中持续维护范围、工作日志和验证证据。

## 完成或暂停任务

- Acceptance 全部满足且 `evidence.md` 完整时，才将总任务清单状态改为 `done`。
- 无法继续时，将状态改为 `blocked`，并在任务目录的 `README.md` 和 `worklog.md` 写明原因与解除条件。
- 会话结束时在任务目录的 `worklog.md` 追加本次结果，并更新 `README.md` 的 Current State 和 Latest Session State。
- 如果实现改变了既定设计，先更新 SDD 中的 ADR，再继续实施。

## 并行规则

所有 Workstream 同级，不存在默认阶段或优先级。不同会话可以并行处理没有依赖关系的任务，但必须遵守：

- 一个任务同一时间只能有一个主工作目录。
- 已经是 `in_progress` 的任务不能被另一会话无记录接管。
- 共享文件发生重叠时，相关任务需要在各自日志中记录协调方式。
- Dependencies 只在总任务清单中表达，目录或文件顺序不代表依赖。
