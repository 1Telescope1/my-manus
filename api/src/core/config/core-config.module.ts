import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SettingsService } from './settings';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      ignoreEnvFile: false,
    }),
  ],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class CoreConfigModule {}
