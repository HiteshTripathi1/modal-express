/**
 * Builds the Express app: JSON body parsing, the API routes mounted under the
 * configured prefix (default `/api`), and the error middleware last.
 */
import express, { Router } from 'express';
import { config } from './config.js';
import health from './routes/health.js';
import sandboxes from './routes/sandboxes.js';
import previews from './routes/previews.js';
import deployments from './routes/deployments.js';
import projects from './routes/projects.js';
import { errorHandler } from './middleware/error.js';
import { apiKeyAuth } from './middleware/auth.js';

export function createApp() {
  const app = express();

  if (!config.apiKey) {
    console.warn(
      '⚠️  API_KEY is not set — request auth is DISABLED. Set API_KEY in .env to require a key.',
    );
  }

  // Permissive CORS so a browser frontend can call the API directly (POC).
  // Tighten the allowed origin before any non-local deployment.
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(express.json({ limit: '25mb' }));

  const api = Router();
  // Every API route requires a valid API key (see middleware/auth.ts).
  api.use(apiKeyAuth);
  api.use('/health', health);
  api.use('/sandboxes', sandboxes);
  api.use('/previews', previews);
  api.use('/deployments', deployments);
  api.use('/projects', projects);

  app.use(config.apiPrefix ? `/${config.apiPrefix}` : '/', api);

  // Unmatched route -> JSON 404 (instead of Express's default HTML page).
  app.use((req, res) => {
    res.status(404).json({
      message: `Cannot ${req.method} ${req.originalUrl}`,
      error: 'Not Found',
      statusCode: 404,
    });
  });

  // Error handler must be registered last.
  app.use(errorHandler);
  return app;
}
