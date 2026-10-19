// Argon2id parameters per OWASP 2024 guidance for interactive logins:
//   memoryCost = 19 MiB, timeCost = 2, parallelism = 1.
// Big enough to make offline cracking painful; small enough that a login
// completes in tens of milliseconds on commodity hardware.
import argon2 from 'argon2';

const OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // Malformed hash (e.g. the '!' placeholder from the migration) or any
    // argon2 internal error must not turn into a 500 — from the caller's
    // perspective, the credentials simply did not match.
    return false;
  }
}