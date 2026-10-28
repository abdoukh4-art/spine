import { randomBytes } from 'node:crypto';
import { hash, verify, type Algorithm, type Options } from '@node-rs/argon2';
import type { PasswordHasher } from '../application/ports.js';

/**
 * OWASP Password Storage Cheat Sheet parameters for argon2id: 19 MiB of memory, 2
 * iterations, 1 lane. Memory-hardness is what makes GPU/ASIC cracking expensive.
 * (`Algorithm` is a `const enum` in the typings, which `isolatedModules` can't inline,
 * hence the literal 2 = Argon2id.)
 */
export const OWASP_ARGON2ID: Options = {
  algorithm: 2 as Algorithm,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/** argon2id implementation of {@link PasswordHasher} (`@node-rs/argon2`, runs off the event loop). */
export class Argon2PasswordHasher implements PasswordHasher {
  private dummyHash: Promise<string> | undefined;

  constructor(private readonly options: Options = OWASP_ARGON2ID) {}

  /** Hashes with a fresh random salt; the PHC string embeds algorithm, params and salt. */
  hash(password: string): Promise<string> {
    return hash(password, this.options);
  }

  /** Verifies in constant time. Malformed stored hashes count as a mismatch. */
  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  /**
   * Verifies against a hash of a random secret nobody knows, computed once with the SAME
   * parameters as real hashes, so the work done matches a real verification.
   */
  async verifyDummy(password: string): Promise<void> {
    await this.verify(await this.warmUp(), password);
  }

  /** Computes the dummy hash ahead of time (call at startup to keep the first login fast). */
  warmUp(): Promise<string> {
    this.dummyHash ??= this.hash(randomBytes(32).toString('base64url'));
    return this.dummyHash;
  }
}
