'use strict';

const mockHealthCheck = jest.fn();

jest.mock('../src/db', () => ({
  initPool: jest.fn(),
  closePool: jest.fn(),
  getPool: jest.fn(),
  withConnection: jest.fn(),
  healthCheck: (...args) => mockHealthCheck(...args),
  oracledb: { BIND_OUT: 3003, NUMBER: 2010 },
}));

const request = require('supertest');
const { buildApp } = require('./helpers/testApp');

const app = buildApp();

describe('GET /health', () => {
  test('reports connected when the pool responds', async () => {
    mockHealthCheck.mockResolvedValueOnce(true);
    const res = await request(app).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', db: 'connected' });
  });

  test('reports error when the probe query fails', async () => {
    mockHealthCheck.mockResolvedValueOnce(false);
    const res = await request(app).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', db: 'error' });
  });

  test('reports error when the pool throws', async () => {
    mockHealthCheck.mockRejectedValueOnce(new Error('pool down'));
    const res = await request(app).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', db: 'error' });
  });

  test('requires no client secret', async () => {
    mockHealthCheck.mockResolvedValueOnce(true);
    await request(app).get('/health').expect(200);
  });
});
