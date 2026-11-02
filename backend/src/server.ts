/**
 * Fastify application: security hooks (Host, Origin, bearer token), validated
 * routes and uniform JSON errors. `createHelper` wires every component and is
 * used by both the CLI and the integration tests.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import {
  API_VERSION,
  APP_VERSION,
  createJobSchema,
  historyQuerySchema,
  jobActionSchema,
  jobIdParamsSchema,
  probeRequestSchema,
  settingsPatchSchema,
  type ApiErrorBody,
  type BackendSettings,
  type HealthResponse,
} from '@clipkeeper/shared';
import { ConfigStore, resolveAppPaths, type AppPaths, type ConfigOverrides } from './config';
import { DependencyManager } from './deps';
import { AppError } from './errors';
import { HistoryStore } from './history';
import { JobManager, type JobManagerOptions } from './jobs/manager';
import { UrlPolicy } from './net/policy';
import { probeMedia } from './probe';
import { nativeSystem, type SystemIntegration } from './system';

export interface ServerDeps {
  config: ConfigStore;
  history: HistoryStore;
  deps: DependencyManager;
  jobs: JobManager;
  system: SystemIntegration;
  logger?: boolean;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const AUTH_FAILURE_LIMIT = 30;
const AUTH_WINDOW_MS = 60_000;

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function tokensMatch(provided: string, expected: string): boolean {
  return timingSafeEqual(digest(provided), digest(expected));
}

function parse<T extends ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value ?? {});
}

function sendError(reply: FastifyReply, status: number, body: ApiErrorBody): FastifyReply {
  return reply.code(status).header('cache-control', 'no-store').send(body);
}

export async function buildServer(ctx: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: ctx.logger ? { level: 'warn', redact: ['req.headers.authorization'] } : false,
    bodyLimit: 64 * 1024,
  });

  let authFailures: { count: number; resetAt: number } = { count: 0, resetAt: Date.now() + AUTH_WINDOW_MS };

  const listeningPort = (): number | undefined => {
    const address = app.server.address() as AddressInfo | null;
    return address?.port;
  };

  const isAllowedOrigin = (origin: string): boolean => {
    const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
    if (!m) return false;
    const allowed = ctx.config.settings.allowedExtensionIds;
    return !allowed.length || allowed.includes(m[1]);
  };

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // 1. DNS-rebinding defence: only loopback Host headers on our own port.
    const host = (request.headers.host ?? '').toLowerCase();
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host);
    const port = listeningPort();
    if (!m || !LOOPBACK_HOSTS.has(m[1]) || (port !== undefined && m[2] !== undefined && Number(m[2]) !== port)) {
      return sendError(reply, 403, { error: { code: 'FORBIDDEN', message: 'Invalid Host header.' } });
    }

    // 2. Browsers attach Origin to cross-origin requests; only the extension may call us.
    const origin = request.headers.origin;
    if (origin !== undefined) {
      if (!isAllowedOrigin(origin)) {
        return sendError(reply, 403, { error: { code: 'FORBIDDEN', message: 'Origin not allowed.' } });
      }
      reply.header('access-control-allow-origin', origin).header('vary', 'Origin');
      if (request.method === 'OPTIONS') {
        return reply
          .code(204)
          .header('access-control-allow-methods', 'GET,POST,PUT,DELETE')
          .header('access-control-allow-headers', 'authorization,content-type')
          .header('access-control-max-age', '600')
          .send();
      }
    }

    if (request.url === '/api/health' || request.url.startsWith('/api/health?')) return;

    // 3. Bearer token.
    const header = request.headers.authorization ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (provided && tokensMatch(provided, ctx.config.token)) return;

    const now = Date.now();
    if (now > authFailures.resetAt) authFailures = { count: 0, resetAt: now + AUTH_WINDOW_MS };
    authFailures.count++;
    if (authFailures.count > AUTH_FAILURE_LIMIT) {
      return sendError(reply, 429, { error: { code: 'RATE_LIMITED', message: 'Too many failed authentication attempts.' } });
    }
    return sendError(reply, 401, {
      error: { code: 'UNAUTHORIZED', message: provided ? 'Invalid helper token.' : 'Missing helper token.' },
    });
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
    return payload;
  });

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    if (error instanceof AppError) {
      return sendError(reply, error.status, { error: { code: error.code, message: error.message, details: error.details } });
    }
    if (error instanceof ZodError) {
      return sendError(reply, 400, {
        error: {
          code: 'BAD_REQUEST',
          message: error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
          details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return sendError(reply, status, { error: { code: status === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST', message: error.message } });
    }
    request.log.error(error);
    return sendError(reply, 500, { error: { code: 'INTERNAL', message: 'Unexpected helper error.' } });
  });

  app.setNotFoundHandler((_request, reply) => sendError(reply, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } }));

  // ---- routes -------------------------------------------------------------

  app.get('/api/health', async (): Promise<HealthResponse> => ({
    ok: true,
    name: 'clipkeeper-helper',
    version: APP_VERSION,
    apiVersion: API_VERSION,
  }));

  app.get('/api/status', async () => ({
    version: APP_VERSION,
    apiVersion: API_VERSION,
    dependencies: await ctx.deps.detect(),
    settings: ctx.config.settings,
    activeJobs: ctx.jobs.activeCount(),
  }));

  app.get('/api/dependencies', async (request) => {
    const refresh = (request.query as Record<string, string> | undefined)?.refresh === '1';
    return { dependencies: await ctx.deps.detect(refresh) };
  });

  app.get('/api/settings', async () => ({ settings: ctx.config.settings }));

  app.put('/api/settings', async (request) => {
    const patch = parse(settingsPatchSchema, request.body);
    return { settings: await ctx.config.updateSettings(patch) };
  });

  app.post('/api/settings/choose-folder', async () => {
    const chosen = await ctx.system.chooseFolder();
    if (!chosen) return { canceled: true };
    const settings: BackendSettings = await ctx.config.updateSettings({ downloadDir: chosen });
    return { path: settings.downloadDir, settings };
  });

  app.post('/api/probe', async (request) => {
    const body = parse(probeRequestSchema, request.body);
    const settings = ctx.config.settings;
    return probeMedia(body, {
      policy: new UrlPolicy(settings),
      settings,
      deps: await ctx.deps.detect(),
      signal: AbortSignal.timeout(60_000),
    });
  });

  app.get('/api/jobs', async () => ({ jobs: ctx.jobs.list() }));

  app.post('/api/jobs', async (request, reply) => {
    const body = parse(createJobSchema, request.body);
    const job = await ctx.jobs.create(body);
    return reply.code(201).send({ job });
  });

  app.get('/api/jobs/:id', async (request) => {
    const { id } = parse(jobIdParamsSchema, request.params);
    return { job: ctx.jobs.get(id) };
  });

  app.post('/api/jobs/:id/reveal', async (request) => {
    const { id } = parse(jobIdParamsSchema, request.params);
    const job = ctx.jobs.get(id);
    if (job.status !== 'completed' || !job.filePath) throw new AppError('INVALID_STATE', 'The file is not available yet.');
    await ctx.system.reveal(job.filePath);
    return { ok: true };
  });

  app.post('/api/jobs/:id/:action', async (request) => {
    const params = request.params as { id?: string; action?: string };
    const { id } = parse(jobIdParamsSchema, { id: params.id });
    const action = jobActionSchema.parse(params.action);
    switch (action) {
      case 'pause':
        return { job: ctx.jobs.pause(id) };
      case 'resume':
        return { job: ctx.jobs.resume(id) };
      case 'cancel':
        return { job: await ctx.jobs.cancel(id) };
      case 'retry':
        return { job: ctx.jobs.retry(id) };
    }
  });

  app.delete('/api/jobs/:id', async (request) => {
    const { id } = parse(jobIdParamsSchema, request.params);
    ctx.jobs.remove(id);
    return { ok: true };
  });

  app.get('/api/history', async (request) => {
    const { limit } = parse(historyQuerySchema, request.query);
    return { entries: ctx.history.list(limit) };
  });

  app.delete('/api/history/:id', async (request) => {
    const { id } = parse(jobIdParamsSchema, request.params);
    if (!(await ctx.history.remove(id))) throw new AppError('NOT_FOUND', 'History entry not found.');
    return { ok: true };
  });

  app.post('/api/history/:id/reveal', async (request) => {
    const { id } = parse(jobIdParamsSchema, request.params);
    const entry = ctx.history.list().find((e) => e.id === id);
    if (!entry?.filePath) throw new AppError('NOT_FOUND', 'History entry not found.');
    await ctx.system.reveal(entry.filePath);
    return { ok: true };
  });

  app.delete('/api/history', async () => {
    await ctx.history.clear();
    return { ok: true };
  });

  return app;
}

export interface HelperOptions {
  home?: string;
  overrides?: ConfigOverrides;
  system?: SystemIntegration;
  logger?: boolean;
  runnerFactory?: JobManagerOptions['runnerFactory'];
}

export interface Helper {
  app: FastifyInstance;
  config: ConfigStore;
  jobs: JobManager;
  history: HistoryStore;
  deps: DependencyManager;
  paths: AppPaths;
  listen(host?: string): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
}

export async function createHelper(options: HelperOptions = {}): Promise<Helper> {
  const paths = resolveAppPaths(options.home);
  const config = await ConfigStore.load(paths, options.overrides);
  const history = await HistoryStore.load(paths.historyFile);
  const deps = new DependencyManager();
  const jobs = new JobManager({ config, history, deps, jobsFile: paths.jobsFile, runnerFactory: options.runnerFactory });
  await jobs.init();
  const app = await buildServer({ config, history, deps, jobs, system: options.system ?? nativeSystem, logger: options.logger });

  return {
    app,
    config,
    jobs,
    history,
    deps,
    paths,
    async listen(host = '127.0.0.1') {
      await app.listen({ host, port: config.port });
      const port = (app.server.address() as AddressInfo).port;
      return { url: `http://127.0.0.1:${port}`, port };
    },
    async close() {
      await jobs.shutdown();
      await app.close();
    },
  };
}
