// Binds a stable request id and, once known, the order id, into the per-request
// logger. Every log line emitted by a route handler automatically carries
// { reqId, orderId? } — no manual threading.
//
// We do NOT put the order id in a header; it goes into logs by calling
// `attachOrderContext(req, orderId)` from the route the moment the id is known.
// That keeps the wire clean while making grep-by-order-id possible.
import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Attach additional context to the request-scoped logger. */
    attachLogContext: (ctx: Record<string, string | number | undefined>) => void;
  }
}

export default fp(
  async (app) => {
    app.decorateRequest('attachLogContext', function (this: FastifyRequest, ctx) {
      // Fastify's request.log is a child pino logger. Calling `.child({...})`
      // on it returns a new child with the merged bindings. We replace the
      // request's logger with that child so subsequent calls inherit the ctx.
      const clean: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(ctx)) {
        if (v !== undefined) clean[k] = v;
      }
      this.log = this.log.child(clean);
    });

    // Timing hook: log completion with duration for every request. This is
    // separate from Fastify's built-in request logging because we want the
    // duration and status on the same line as the reqId.
    app.addHook('onResponse', async (req, reply) => {
      req.log.info(
        {
          method: req.method,
          url: req.url,
          statusCode: reply.statusCode,
          durationMs: Math.round(reply.elapsedTime),
        },
        'request completed',
      );
    });
  },
  { name: 'request-context' },
);