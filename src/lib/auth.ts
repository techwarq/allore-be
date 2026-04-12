import { SignJWT, jwtVerify } from 'jose'
import bcrypt from 'bcryptjs'
import { Google } from 'arctic'

// --- Password Hashing ---
export const hashPassword = async (password: string): Promise<string> => {
  return await bcrypt.hash(password, 10)
}

export const verifyPassword = async (password: string, hash: string): Promise<boolean> => {
  return await bcrypt.compare(password, hash)
}

// --- JWT Handling ---
export const signJWT = async (payload: any, secret: string): Promise<string> => {
  const secretKey = new TextEncoder().encode(secret)
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secretKey)
}

export const verifyJWT = async (token: string, secret: string) => {
  const secretKey = new TextEncoder().encode(secret)
  try {
    const { payload } = await jwtVerify(token, secretKey)
    return payload
  } catch (error) {
    return null
  }
}

// --- OAuth ---
export const getGoogleProvider = (clientId: string, clientSecret: string, redirectUrl: string) => {
  return new Google(clientId, clientSecret, redirectUrl)
}
