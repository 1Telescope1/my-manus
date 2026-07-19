import { Injectable } from '@nestjs/common';
import { Task, TaskManager, TaskRunner } from '../../../domain/external/task';
import { RedisClient } from '../../storage/redis.client';
import { RedisStreamTask } from './redis-stream-task';

type ManagedTask = {
  task: RedisStreamTask;
  runner: TaskRunner;
};

/** 管理当前 API 进程中的 Redis Stream 任务实例。 */
@Injectable()
export class RedisStreamTaskManager extends TaskManager {
  private readonly tasks = new Map<string, ManagedTask>();

  constructor(private readonly redis: RedisClient) {
    super();
  }

  create(runner: TaskRunner): Task {
    const task = new RedisStreamTask(runner, this.redis, (taskId) => {
      this.tasks.delete(taskId);
    });
    this.tasks.set(task.id, { task, runner });
    return task;
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId)?.task;
  }

  async destroy(): Promise<void> {
    // 复制当前任务，避免 cancel 删除 Map 项时影响遍历。
    const managedTasks = [...this.tasks.values()];
    this.tasks.clear();

    for (const { task, runner } of managedTasks) {
      task.cancel();
      await task.waitForCompletion();
      await runner.destroy();
    }
  }
}
