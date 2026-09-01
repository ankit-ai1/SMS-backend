import bcrypt from 'bcryptjs';

const ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** Basic strength gate; endpoints layer validation on top. */
export function isPasswordAcceptable(plain: string): boolean {
  return typeof plain === 'string' && plain.length >= 8;
}
