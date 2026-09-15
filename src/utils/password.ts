/**
 * Password hashing via Bun.password (bcrypt), mirroring Laravel's
 * `password => hashed` cast (BCRYPT_ROUNDS=12 in .env.example).
 */
export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, { algorithm: "bcrypt", cost: 12 });
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return Bun.password.verify(plain, hash);
}
