import { describe, expect, it } from 'vitest';
import { isAllowedHost, isAllowedOrigin } from '../src/security/origin.js';

describe('isAllowedOrigin', () => {
  it('운영 origin 만 허용', () => {
    expect(isAllowedOrigin('https://studio.aeyes.dev', false)).toBe(true);
    expect(isAllowedOrigin('https://seller-ai-studio.vercel.app', false)).toBe(true);
    expect(isAllowedOrigin('https://evil.example.com', false)).toBe(false);
    expect(isAllowedOrigin('https://studio.aeyes.dev.evil.com', false)).toBe(false);
    expect(isAllowedOrigin('http://studio.aeyes.dev', false)).toBe(false);
    expect(isAllowedOrigin(undefined, false)).toBe(false);
    expect(isAllowedOrigin('null', false)).toBe(false);
  });
  it('localhost 는 dev 에서만', () => {
    expect(isAllowedOrigin('http://localhost:3000', false)).toBe(false);
    expect(isAllowedOrigin('http://localhost:3000', true)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:5173', true)).toBe(true);
    expect(isAllowedOrigin('https://localhost:3000', true)).toBe(false);
    expect(isAllowedOrigin('http://localhost.evil.com', true)).toBe(false);
  });
});

describe('isAllowedHost', () => {
  it('127.0.0.1 / localhost 와 포트가 정확히 같아야 한다', () => {
    expect(isAllowedHost('127.0.0.1:47821', 47821)).toBe(true);
    expect(isAllowedHost('localhost:47821', 47821)).toBe(true);
    expect(isAllowedHost('localhost:47822', 47821)).toBe(false);
    expect(isAllowedHost('evil.com:47821', 47821)).toBe(false);
    expect(isAllowedHost('127.0.0.1', 47821)).toBe(false);
    expect(isAllowedHost(undefined, 47821)).toBe(false);
  });
});
