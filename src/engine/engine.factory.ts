import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IWhatsAppEngine } from './interfaces/whatsapp-engine.interface';
import { WhatsAppWebJsAdapter } from './adapters/whatsapp-web-js.adapter';
import { BaileysAdapter } from './adapters/baileys.adapter';
import { PluginLoaderService, PluginType, IEnginePlugin, PluginManifest } from '../core/plugins';
import { WhatsAppWebJsPlugin } from '../plugins/engines/whatsapp-web-js';
import { BaileysPlugin } from '../plugins/engines/baileys';
import { createLogger } from '../common/services/logger.service';

export interface EngineCreateOptions {
  sessionId: string;
  proxyUrl?: string;
  proxyType?: 'http' | 'https' | 'socks4' | 'socks5';
}

@Injectable()
export class EngineFactory implements OnModuleInit {
  private readonly logger = createLogger('EngineFactory');
  private readonly engineType: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly pluginLoader: PluginLoaderService,
  ) {
    this.engineType = this.configService.get<string>('engine.type') ?? 'baileys';
  }

  async onModuleInit(): Promise<void> {
    // Register built-in engine plugins
    await this.registerBuiltInEngines();
  }

  private async registerBuiltInEngines(): Promise<void> {
    // 1. Register WhatsApp-web.js as built-in plugin
    const wwjsManifest: PluginManifest = {
      id: 'whatsapp-web.js',
      name: 'WhatsApp Web.js Engine',
      version: '1.0.0',
      type: PluginType.ENGINE,
      description: 'Official WhatsApp-web.js engine adapter (Chromium)',
      main: 'index.ts',
      provides: ['whatsapp-engine'],
    };
    const wwjsPlugin = new WhatsAppWebJsPlugin();
    this.pluginLoader.registerBuiltInPlugin(wwjsManifest, wwjsPlugin);

    // 2. Register Baileys as built-in plugin (Zero Chromium)
    const baileysManifest: PluginManifest = {
      id: 'baileys',
      name: 'Baileys Engine',
      version: '1.0.0',
      type: PluginType.ENGINE,
      description: 'High-performance direct WebSocket WhatsApp engine (Zero Chromium)',
      main: 'index.ts',
      provides: ['whatsapp-engine'],
    };
    const baileysPlugin = new BaileysPlugin();
    this.pluginLoader.registerBuiltInPlugin(baileysManifest, baileysPlugin);

    // Auto-enable the configured engine
    try {
      await this.pluginLoader.enablePlugin(this.engineType);
      this.logger.log(`Engine plugin enabled: ${this.engineType}`, {
        action: 'engine_enabled',
        engineType: this.engineType,
      });
    } catch (error) {
      this.logger.error(
        `Failed to enable engine plugin: ${this.engineType}`,
        error instanceof Error ? error.message : String(error),
        { action: 'engine_enable_failed' },
      );
    }
  }

  create(options: EngineCreateOptions): IWhatsAppEngine {
    // Try to get engine from plugin system
    const enginePlugin = this.pluginLoader.getPlugin(this.engineType);

    if (enginePlugin?.instance && this.isEnginePlugin(enginePlugin.instance)) {
      return enginePlugin.instance.createEngine({
        sessionId: options.sessionId,
        proxyUrl: options.proxyUrl,
        proxyType: options.proxyType,
      }) as IWhatsAppEngine;
    }

    // Fallback to direct adapter creation (legacy support)
    this.logger.warn(`Engine plugin ${this.engineType} not available, using fallback`, {
      action: 'engine_fallback',
    });

    return this.createFallbackEngine(options);
  }

  private isEnginePlugin(instance: unknown): instance is IEnginePlugin {
    return (
      typeof instance === 'object' &&
      instance !== null &&
      'type' in instance &&
      (instance as { type: unknown }).type === PluginType.ENGINE &&
      'createEngine' in instance &&
      typeof (instance as { createEngine: unknown }).createEngine === 'function'
    );
  }

  private createFallbackEngine(options: EngineCreateOptions): IWhatsAppEngine {
    if (this.engineType === 'baileys') {
      return new BaileysAdapter({
        sessionId: options.sessionId,
        sessionDataPath: this.configService.get<string>('engine.sessionDataPath') ?? './data/sessions',
        proxy: options.proxyUrl
          ? {
              url: options.proxyUrl,
              type: options.proxyType ?? 'http',
            }
          : undefined,
      });
    }

    // Legacy direct creation (fallback for whatsapp-web.js)
    return new WhatsAppWebJsAdapter({
      sessionId: options.sessionId,
      sessionDataPath: this.configService.get<string>('engine.sessionDataPath') ?? './data/sessions',
      puppeteer: {
        headless: this.configService.get<boolean>('engine.puppeteer.headless') ?? true,
        args: this.configService.get<string[]>('engine.puppeteer.args') ?? ['--no-sandbox', '--disable-setuid-sandbox'],
      },
      proxy: options.proxyUrl
        ? {
            url: options.proxyUrl,
            type: options.proxyType ?? 'http',
          }
        : undefined,
    });
  }

  // ============================================================================
  // Query Methods for API/Dashboard
  // ============================================================================

  getAvailableEngines(): Array<{ id: string; name: string; enabled: boolean; features: string[] }> {
    const enginePlugins = this.pluginLoader.getPluginsByType(PluginType.ENGINE);

    return enginePlugins.map(plugin => {
      const features = plugin.instance && this.isEnginePlugin(plugin.instance) ? plugin.instance.getFeatures() : [];

      return {\n        id: plugin.manifest.id,\n        name: plugin.manifest.name,\n        enabled: this.pluginLoader.isPluginEnabled(plugin.manifest.id),\n        features,\n      };\n    });\n  }\n\n  getCurrentEngine(): string {\n    return this.engineType;\n  }\n}\n