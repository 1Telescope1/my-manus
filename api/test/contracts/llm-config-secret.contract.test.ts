import assert from 'node:assert/strict';
import test from 'node:test';
import { AppConfigService } from '../../src/application/services/app-config.service';
import {
  AppConfig,
  createDefaultAppConfig,
} from '../../src/domain/models/app-config';
import { FileAppConfigRepository } from '../../src/infrastructure/repositories/file-app-config.repository';

function createService(apiKey: string): {
  service: AppConfigService;
  getStoredConfig: () => AppConfig;
} {
  let storedConfig = createDefaultAppConfig();
  storedConfig.llm_config.api_key = apiKey;

  const repository = {
    async load(): Promise<AppConfig> {
      return structuredClone(storedConfig);
    },
    async save(config: AppConfig): Promise<void> {
      storedConfig = structuredClone(config);
    },
  } as unknown as FileAppConfigRepository;

  return {
    service: new AppConfigService(repository),
    getStoredConfig: () => storedConfig,
  };
}

test('读取 LLM 配置不应暴露密钥，只返回配置状态', async () => {
  const { service } = createService('secret-key');

  const response = await service.getLlmConfig();

  assert.equal('api_key' in response, false);
  assert.equal(response.has_api_key, true);
});

test('更新 LLM 配置时未传或传空密钥应沿用原密钥', async () => {
  const { service, getStoredConfig } = createService('secret-key');
  const editableConfig = {
    base_url: 'https://api.deepseek.com',
    model_name: 'deepseek-reasoner',
    temperature: 0.2,
    max_tokens: 4096,
  };

  const missingKeyResponse = await service.updateLlmConfig(editableConfig);
  assert.equal(getStoredConfig().llm_config.api_key, 'secret-key');
  assert.equal(missingKeyResponse.has_api_key, true);
  assert.equal('api_key' in missingKeyResponse, false);

  await service.updateLlmConfig({ ...editableConfig, api_key: '' });
  assert.equal(getStoredConfig().llm_config.api_key, 'secret-key');
});

test('更新 LLM 配置时传入新密钥应安全替换原密钥', async () => {
  const { service, getStoredConfig } = createService('old-key');

  const response = await service.updateLlmConfig({
    base_url: 'https://api.deepseek.com',
    api_key: 'new-key',
    model_name: 'deepseek-reasoner',
    temperature: 0.7,
    max_tokens: 8192,
  });

  assert.equal(getStoredConfig().llm_config.api_key, 'new-key');
  assert.equal(response.has_api_key, true);
  assert.equal('api_key' in response, false);
});
