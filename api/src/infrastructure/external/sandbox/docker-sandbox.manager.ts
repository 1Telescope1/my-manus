import { Injectable } from '@nestjs/common';
import { Sandbox, SandboxManager } from '../../../domain/external/sandbox';
import { DockerSandbox } from './docker-sandbox';

/** 通过 Docker 容器创建和恢复沙箱实例。 */
@Injectable()
export class DockerSandboxManager extends SandboxManager {
  create(): Promise<Sandbox> {
    return DockerSandbox.create();
  }

  get(id: string): Promise<Sandbox | null> {
    return DockerSandbox.get(id);
  }
}
