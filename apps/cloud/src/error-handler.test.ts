import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { cloudErrorHandler } from './server.js';

describe('@mezon/cloud - error handler', () => {
  it('a server error answers 500 without internal details; client errors keep their message', async () => {
    const app = Fastify({ logger: false });
    app.setErrorHandler(cloudErrorHandler);
    app.get('/boom', () => {
      throw new Error('column p.secret_column does not exist');
    });
    app.get('/bad', () => {
      throw Object.assign(new Error('Bad input'), { statusCode: 400, code: 'BAD' });
    });
    await app.ready();

    const boom = await app.inject({ method: 'GET', url: '/boom' });
    expect(boom.statusCode).toBe(500);
    expect(boom.payload).not.toContain('secret_column');
    expect(JSON.parse(boom.payload)).toEqual({ error: 'Internal Server Error' });

    const bad = await app.inject({ method: 'GET', url: '/bad' });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.payload)).toMatchObject({ code: 'BAD', message: 'Bad input' });
    await app.close();
  });
});
