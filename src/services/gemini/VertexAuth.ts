import * as jose from 'jose';

export class VertexAuth {
  private static tokenCache: { token: string; expires: number } | null = null;

  /**
   * Generates a Google OAuth2 Access Token using a Service Account.
   */
  static async getAccessToken(clientEmail: string, privateKey: string): Promise<string> {
    // 1. Check cache
    if (this.tokenCache && this.tokenCache.expires > Date.now()) {
      return this.tokenCache.token;
    }

    // 2. Format Private Key (Cloudflare requires specific handling for newlines)
    const formattedKey = privateKey.replace(/\\n/g, '\n');

    // 3. Create JWT Header and Payload
    const now = Math.floor(Date.now() / 1000);
    const iat = now;
    const exp = now + 3600; // 1 hour

    const payload = {
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      exp: exp,
      iat: iat,
    };

    // 4. Sign JWT using jose
    const privateKeyObj = await jose.importPKCS8(formattedKey, 'RS256');
    const jwt = await new jose.SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(privateKeyObj);

    // 5. Exchange JWT for Access Token
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get Google Access Token: ${error}`);
    }

    const data: any = await response.json();
    const token = data.access_token;

    // 6. Cache it (expire 5 mins early to be safe)
    this.tokenCache = {
      token,
      expires: Date.now() + (data.expires_in - 300) * 1000,
    };

    return token;
  }
}
