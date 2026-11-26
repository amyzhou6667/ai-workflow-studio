import crypto from 'node:crypto';
import { LexRagError } from '../types/index.ts';

export interface AuthStatus {
  singleUserMode: boolean;
  authenticated: boolean;
}

interface FailureRecord {
  count: number;
  lockedUntilMs: number;
}

/**
 * 轻量级管理员口令鉴权守卫：
 * - 支持 SINGLE_USER_MODE 单机免密模式；
 * - 同一来源连续 5 次输错口令触发 60 秒锁定冷却。
 */
export class AuthGuard {
  private readonly passcode: string;
  private readonly singleUserMode: boolean;
  private readonly tokens = new Map<string, number>();
  private readonly failures = new Map<string, FailureRecord>();
  private readonly tokenTtlMs = 24 * 60 * 60 * 1000;
  private readonly cooldownMs = 60 * 1000;

  constructor(options?: { passcode?: string; singleUserMode?: boolean }) {
    this.passcode = options?.passcode ?? process.env.ADMIN_PASSCODE ?? 'lexrag-admin';
    this.singleUserMode =
      options?.singleUserMode ?? (process.env.SINGLE_USER_MODE || '').toLowerCase() === 'true';
  }

  public isSingleUserMode(): boolean {
    return this.singleUserMode;
  }

  public login(passcode: string, sourceKey: string): { token: string; expiresAt: string } {
    if (this.singleUserMode) {
      const token = `single_${crypto.randomUUID()}`;
      const exp = Date.now() + this.tokenTtlMs;
      this.tokens.set(token, exp);
      return { token, expiresAt: new Date(exp).toISOString() };
    }

    const now = Date.now();
    const rec = this.failures.get(sourceKey) || { count: 0, lockedUntilMs: 0 };
    if (rec.lockedUntilMs > now) {
      const remainSec = Math.ceil((rec.lockedUntilMs - now) / 1000);
      throw new LexRagError('TOO_MANY_ATTEMPTS', `口令连续错误次数过多，请 ${remainSec} 秒后再试`, 429);
    }

    if ((passcode || '').trim() !== this.passcode) {
      const nextCount = rec.count + 1;
      if (nextCount >= 5) {
        this.failures.set(sourceKey, { count: 0, lockedUntilMs: now + this.cooldownMs });
      } else {
        this.failures.set(sourceKey, { count: nextCount, lockedUntilMs: 0 });
      }
      throw new LexRagError('UNAUTHORIZED', '管理员口令不正确', 401);
    }

    this.failures.delete(sourceKey);
    const token = `adm_${crypto.randomBytes(24).toString('hex')}`;
    const exp = now + this.tokenTtlMs;
    this.tokens.set(token, exp);
    return { token, expiresAt: new Date(exp).toISOString() };
  }

  public verifyToken(token: string | undefined): boolean {
    if (this.singleUserMode) return true;
    if (!token) return false;
    const clean = token.startsWith('Bearer ') ? token.slice(7).trim() : token.trim();
    const exp = this.tokens.get(clean);
    if (!exp) return false;
    if (exp < Date.now()) {
      this.tokens.delete(clean);
      return false;
    }
    return true;
  }

  public getStatus(token: string | undefined): AuthStatus {
    return {
      singleUserMode: this.singleUserMode,
      authenticated: this.verifyToken(token)
    };
  }
}
