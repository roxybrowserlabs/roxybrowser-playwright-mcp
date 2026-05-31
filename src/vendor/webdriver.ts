import WebDriver from "webdriver";
import type { Client as WebDriverClient } from "webdriver";

export interface WebDriverModule {
  attachToSession(options: {
    sessionId: string;
    capabilities: {
      webSocketUrl: string;
      browserName: string;
    };
  }): WebDriverClient;
}

const defaultWebDriverModule = WebDriver as unknown as WebDriverModule;

let webdriverModule: WebDriverModule = defaultWebDriverModule;

export function getWebDriverModule(): WebDriverModule {
  return webdriverModule;
}

export function setWebDriverModuleForTests(module: WebDriverModule): void {
  webdriverModule = module;
}

export function resetWebDriverModuleForTests(): void {
  webdriverModule = defaultWebDriverModule;
}
