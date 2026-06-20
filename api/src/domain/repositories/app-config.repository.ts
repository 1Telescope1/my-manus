import { AppConfig } from '../models/app-config';

export abstract class AppConfigRepository {
  abstract load(): Promise<AppConfig>;
  abstract save(appConfig: AppConfig): Promise<void>;
}
