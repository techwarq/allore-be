import { Resend } from 'resend'

/**
 * Shared Style Tokens based on the Allore Design System
 */
const BRAND_STYLES = {
  background: '#010810',
  navy1: '#051525',
  accent: '#4FC3F7',
  foreground: '#E8F4FD',
  gray: '#b0b0b0',
}

const commonHead = `
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,100..900;1,9..144,100..900&family=Inter:wght@400;600&display=swap" rel="stylesheet">
    <style>
      body { 
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; 
        background-color: ${BRAND_STYLES.background}; 
        margin: 0; padding: 0; color: ${BRAND_STYLES.foreground}; 
      }
      .container { 
        max-width: 600px; margin: 20px auto; 
        background-color: ${BRAND_STYLES.navy1}; 
        border-radius: 20px; overflow: hidden; 
        border: 1px solid rgba(232, 244, 253, 0.05);
        position: relative;
      }
      .backdrop-text {
        position: absolute;
        top: 50%;
        left: 50%;
        font-family: 'Fraunces', serif;
        font-size: 160px;
        color: rgba(232, 244, 253, 0.02);
        font-weight: 900;
        font-style: italic;
        z-index: 0;
        transform: translate(-50%, -50%);
        pointer-events: none;
      }
      .atmos-glow {
        position: absolute;
        top: -100px;
        right: -100px;
        width: 300px;
        height: 300px;
        background: radial-gradient(circle, rgba(79, 195, 247, 0.1) 0%, transparent 70%);
        filter: blur(60px);
        z-index: 0;
        pointer-events: none;
      }
      .header { padding: 40px 30px 20px; text-align: center; position: relative; z-index: 1; }
      .content { padding: 0 40px 40px; text-align: center; position: relative; z-index: 1; }
      h1 { 
        font-family: 'Fraunces', serif;
        font-size: 28px; font-weight: 700; margin-bottom: 20px;
        letter-spacing: -0.02em; color: ${BRAND_STYLES.foreground};
      }
      p { font-size: 15px; line-height: 1.6; color: ${BRAND_STYLES.gray}; margin-bottom: 30px; }
      .button { 
        display: inline-block; padding: 20px 48px; 
        background-color: ${BRAND_STYLES.accent}; 
        color: ${BRAND_STYLES.background} !important; 
        text-decoration: none; border-radius: 16px; 
        font-weight: 800; font-size: 12px;
        text-transform: uppercase; letter-spacing: 0.2em;
        box-shadow: 0 10px 30px rgba(79, 195, 247, 0.2);
      }
      .footer { 
        padding: 40px; text-align: center; font-size: 11px; 
        color: rgba(232, 244, 253, 0.2); 
        letter-spacing: 0.1em; text-transform: uppercase;
        border-top: 1px solid rgba(232, 244, 253, 0.03); 
      }
      .lowercase { text-transform: lowercase; }
    </style>
  </head>
`

export const sendVerificationEmail = async (apiKey: string, email: string, token: string, baseUrl: string) => {
  const resend = new Resend(apiKey)
  const verifyUrl = `${baseUrl}/auth/verify-email?token=${token}`

  try {
    console.log('📬 Attempting to send email to:', email)
    const result = await resend.emails.send({
      from: 'Allore AI <sonali@alloreai.com>',
      to: email,
      subject: 'verify your identity - allore ai',
      html: `
        <!DOCTYPE html>
        <html class="lowercase">
        ${commonHead}
        <body>
          <div class="container">
            <!-- Background Elements -->
            <div class="atmos-glow"></div>
            <div class="backdrop-text">allore</div>

            <div class="header">
              <img src="https://alloreai.com/draw-logo.svg" alt="Allore AI" style="height: 32px; display: inline-block; vertical-align: middle;">
              <div style="height: 1px; width: 40px; background: ${BRAND_STYLES.accent}; margin: 24px auto; opacity: 0.1;"></div>
            </div>
            <div class="content">
              <h1>verify your identity</h1>
              <p>welcome to the future of intelligence. your workspace is ready, we just need to confirm it&apos;s you.</p>
              <a href="${verifyUrl}" class="button">verify my email</a>
              <p style="margin-top: 40px; font-size: 12px; opacity: 0.5;">this secure link will expire in 24 hours.</p>
            </div>
            <div class="footer">
              &copy; 2026 allore ai. infinite creativity.<br>
              all rights reserved.
            </div>
          </div>
        </body>
        </html>
      `,
    })

    if (result.error) {
      console.error('❌ Resend Error:', JSON.stringify(result.error, null, 2))
      return { data: null, error: result.error }
    }

    return { data: result.data, error: null }
  } catch (err) {
    console.error('❌ Unexpected Email Error:', err)
    return { data: null, error: err }
  }
}

export const sendPasswordResetEmail = async (apiKey: string, email: string, token: string, baseUrl: string) => {
  const resend = new Resend(apiKey)
  const resetUrl = `${baseUrl}/auth/reset-password?token=${token}`

  return await resend.emails.send({
    from: 'Allore AI <sonali@alloreai.com>',
    to: email,
    subject: 'reset your password - allore ai',
    html: `
        <!DOCTYPE html>
        <html class="lowercase">
        ${commonHead}
        <body>
          <div class="container">
            <!-- Background Elements -->
            <div class="atmos-glow"></div>
            <div class="backdrop-text">allore</div>

            <div class="header">
              <img src="https://alloreai.com/draw-logo.svg" alt="Allore AI" style="height: 32px; display: inline-block; vertical-align: middle;">
              <div style="height: 1px; width: 40px; background: ${BRAND_STYLES.accent}; margin: 24px auto; opacity: 0.1;"></div>
            </div>
            <div class="content">
              <h1>reset your password</h1>
              <p>we received a request to reset your password. if this was you, step into your new security settings below.</p>
              <a href="${resetUrl}" class="button">reset password</a>
              <p style="margin-top: 40px; font-size: 12px; opacity: 0.5;">if you didn&apos;t request this, you can safely ignore this email.</p>
            </div>
            <div class="footer">
              &copy; 2026 allore ai. infinite creativity.<br>
              all rights reserved.
            </div>
          </div>
        </body>
        </html>
      `,
  })
}

export const sendWaitlistWelcomeEmail = async (apiKey: string, email: string, name?: string) => {
  const resend = new Resend(apiKey)
  const recipientName = name ? name.split(' ')[0].toLowerCase() : 'there'

  try {
    console.log('📬 Attempting to send waitlist welcome email to:', email)
    const result = await resend.emails.send({
      from: 'Founders <founders@alloreai.com>',
      to: email,
      subject: 'welcome to allore ai',
      html: `
<!DOCTYPE html>
<html>
${commonHead}
<body style="margin:0; padding:0; background:#0a0a0a; font-family: -apple-system, BlinkMacSystemFont, sans-serif; color:#eaeaea;">
  <div style="max-width:520px; margin:0 auto; padding:32px 20px;">

    <!-- Card -->
    <div style="background:#111; border:1px solid rgba(255,255,255,0.06); border-radius:16px; padding:28px;">

      <h1 style="font-size:20px; margin:0 0 16px 0; font-weight:500; letter-spacing:-0.02em;">
        welcome to the waitlist
      </h1>

      <p style="margin:0 0 12px 0; color:#aaa;">hi ${recipientName},</p>

      <p style="margin:0 0 12px 0; line-height:1.6;">
        we're the founders of allore ai. thanks for joining — you're early.
      </p>

      <p style="margin:0 0 12px 0; line-height:1.6;">
        you are one of our first 100 waitlist applicants, so we want to give you something special. keep an eye on ur mails we will send a code for 200 free credits when we launch.
      </p>

      <p style="margin:0 0 12px 0; line-height:1.6;">
        we're building an ai creative studio where ideas turn into live drops in minutes.
      </p>

      <p style="margin:0 0 12px 0; line-height:1.6;">
        follow us on X for our next updates: <a href="https://x.com/usealloreai" style="color: #4FC3F7; text-decoration: none;">https://x.com/usealloreai</a>
      </p>

      <p style="margin:0 0 20px 0; line-height:1.6;">
        stick with us, we promise it will be very worth it! :)
      </p>

      <!-- subtle divider -->
      <div style="height:1px; background:rgba(255,255,255,0.06); margin:20px 0;"></div>

      <p style="margin:0; font-size:13px; color:#888;">
        — the founders<br>
        Allore AI
      </p>

    </div>

    <!-- Footer -->
    <div style="text-align:center; font-size:11px; color:#666; margin-top:20px;">
      © 2026 Allore AI
    </div>

  </div>
</body>
</html>
`,
    })

    if (result.error) {
      console.error('❌ Resend Error:', JSON.stringify(result.error, null, 2))
      return { data: null, error: result.error }
    }

    return { data: result.data, error: null }
  } catch (err) {
    console.error('❌ Unexpected Email Error:', err)
    return { data: null, error: err }
  }
}
