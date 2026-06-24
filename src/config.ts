/**
 * Loads `.env` (via dotenv) and exposes a typed config object — the Express
 * equivalent of Nest's `ConfigModule.forRoot({ envFilePath: '.env' })` +
 * `ConfigService`.
 */
import 'dotenv/config';

export interface AppConfig {
  appName: string;
  port: number;
  apiPrefix: string;
  nodeEnv: string;
  /** Shared API key required on every request (empty = auth disabled). */
  apiKey?: string;
  modalTokenId?: string;
  modalTokenSecret?: string;
  /** Cloudflare defaults for /publish (a request body can still override these). */
  cloudflare: {
    apiToken?: string;
    accountId?: string;
    zoneId?: string;
  };
  /** Defaults for POST /previews so a browser client never has to hold the git token. */
  preview: {
    repoUrl?: string;
    token?: string;
    port?: number;
    installCmd?: string;
    devCmd?: string;
  };
}

export const config: AppConfig = {
  appName: process.env.APP_NAME ?? 'Modal POC',
  port: Number(process.env.PORT ?? 3000),
  apiPrefix: process.env.API_PREFIX ?? '',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  apiKey: process.env.API_KEY,
  modalTokenId: process.env.MODAL_TOKEN_ID,
  modalTokenSecret: process.env.MODAL_TOKEN_SECRET,
  cloudflare: {
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    zoneId: process.env.CLOUDFLARE_ZONE_ID,
  },
  preview: {
    repoUrl: process.env.GIT_REPO_URL,
    token: process.env.GIT_TOKEN,
    port: process.env.DEV_PORT ? Number(process.env.DEV_PORT) : undefined,
    installCmd: process.env.INSTALL_CMD,
    devCmd: process.env.DEV_CMD,
  },
};
