import { describe, expect, it, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from './helpers/app.js';

describe('auth', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeApp();
  });

  it('registers an organizer and returns a JWT + user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'org1@example.com',
        password: 'correct horse battery staple',
        displayName: 'Organizer One',
        role: 'organizer',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.accessToken).toBeTypeOf('string');
    expect(body.expiresIn).toBeGreaterThan(0);
    expect(body.user.email).toBe('org1@example.com');
    expect(body.user.role).toBe('organizer');
  });

  it('rejects a duplicate email with 409', async () => {
    const payload = {
      email: 'dup@example.com',
      password: 'correct horse battery staple',
      displayName: 'Dup',
      role: 'organizer',
    };
    const first = await app.inject({ method: 'POST', url: '/auth/register', payload });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/auth/register', payload });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('CONFLICT');
  });

  it('rejects a weak password with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'weak@example.com',
        password: 'short',
        displayName: 'Weak',
        role: 'organizer',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('logs in with the correct password', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'login@example.com',
        password: 'correct horse battery staple',
        displayName: 'Login',
        role: 'organizer',
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'login@example.com', password: 'correct horse battery staple' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTypeOf('string');
  });

  it('returns 401 for a wrong password, with the same message as an unknown email', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'known@example.com',
        password: 'correct horse battery staple',
        displayName: 'K',
        role: 'organizer',
      },
    });
    const wrongPass = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'known@example.com', password: 'not the right password' },
    });
    const unknownEmail = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@example.com', password: 'whatever password' },
    });
    expect(wrongPass.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPass.json().error.message).toBe(unknownEmail.json().error.message);
  });

  it('GET /auth/me with a valid token returns the user', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'me@example.com',
        password: 'correct horse battery staple',
        displayName: 'Me',
        role: 'organizer',
      },
    });
    const token = reg.json().accessToken as string;
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe('me@example.com');
  });

  it('GET /auth/me without a token returns 401 in the standard shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Missing or invalid access token' },
    });
  });
});