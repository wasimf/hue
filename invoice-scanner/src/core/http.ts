import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

/**
 * The concrete Fastify instance type used across the app. Naming it once keeps
 * route modules free of Fastify's generic soup, which would otherwise leak in
 * because we hand Fastify our own pino instance.
 */
export type AppInstance = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>;
