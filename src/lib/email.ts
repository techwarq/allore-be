import { Resend } from 'resend'

export const sendVerificationEmail = async (apiKey: string, email: string, token: string, baseUrl: string) => {
  const resend = new Resend(apiKey)
  const verifyUrl = `${baseUrl}/auth/verify-email?token=${token}`

  try {
    console.log('📬 Attempting to send email to:', email)
    const result = await resend.emails.send({
      from: 'Allore AI <sonali@alloreai.com>',
      to: email,
      subject: 'Verify your email address - Allore AI',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
          <style>
            body { font-family: 'Inter', sans-serif; background-color: #0d0d0d; margin: 0; padding: 0; color: #ffffff; }
            .container { max-width: 600px; margin: 20px auto; background: #1a1a1a; border-radius: 16px; overflow: hidden; border: 1px solid #333; }
            .header { height: 180px; background: linear-gradient(135deg, #0070f3 0%, #7928ca 100%); display: flex; align-items: center; justify-content: center; position: relative; }
            .content { padding: 40px; text-align: center; }
            h1 { font-size: 28px; margin-bottom: 20px; font-weight: 600; background: linear-gradient(to right, #ffffff, #888); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
            p { font-size: 16px; line-height: 1.6; color: #b0b0b0; margin-bottom: 30px; }
            .button { display: inline-block; padding: 14px 40px; background: #ffffff; color: #000000 !important; text-decoration: none; border-radius: 50px; font-weight: 600; font-size: 16px; transition: transform 0.2s; box-shadow: 0 4px 15px rgba(255, 255, 255, 0.1); }
            .footer { padding: 30px; text-align: center; font-size: 14px; color: #666; border-top: 1px solid #222; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <!-- Once you host the allore_email_header image on a CDN, replace this placeholder -->
              <div style="font-size: 40px; font-weight: 900; color: white;">ALLORE</div>
            </div>
            <div class="content">
              <h1>Verify your identity</h1>
              <p>Welcome to Allore AI. Step into the future of intelligence. Use the button below to confirm your email and unlock your workspace.</p>
              <a href="${verifyUrl}" class="button">Verify My Email</a>
              <p style="margin-top: 30px; font-size: 13px;">This secure link will expire in 24 hours.</p>
            </div>
            <div class="footer">
              &copy; 2026 Allore AI. Infinite Creativity. <br> Artificial Intelligence for professionals.
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
    from: 'Allore AI<sonali@alloreai.com>',
    to: email,
    subject: 'Reset your password - Allore AI',
    html: `
        <!DOCTYPE html>
        <html>
        <head>
          <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
          <style>
            body { font-family: 'Inter', sans-serif; background-color: #0d0d0d; margin: 0; padding: 0; color: #ffffff; }
            .container { max-width: 600px; margin: 20px auto; background: #1a1a1a; border-radius: 16px; overflow: hidden; border: 1px solid #333; }
            .header { height: 180px; background: linear-gradient(135deg, #7928ca 0%, #ff0080 100%); display: flex; align-items: center; justify-content: center; position: relative; }
            .content { padding: 40px; text-align: center; }
            h1 { font-size: 28px; margin-bottom: 20px; font-weight: 600; background: linear-gradient(to right, #ffffff, #888); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
            p { font-size: 16px; line-height: 1.6; color: #b0b0b0; margin-bottom: 30px; }
            .button { display: inline-block; padding: 14px 40px; background: #ffffff; color: #000000 !important; text-decoration: none; border-radius: 50px; font-weight: 600; font-size: 16px; transition: transform 0.2s; box-shadow: 0 4px 15px rgba(255, 255, 255, 0.1); }
            .footer { padding: 30px; text-align: center; font-size: 14px; color: #666; border-top: 1px solid #222; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <div style="font-size: 40px; font-weight: 900; color: white;">ALLORE</div>
            </div>
            <div class="content">
              <h1>Reset your password</h1>
              <p>We received a request to reset your password. If this was you, click the button below to choose a new secure password.</p>
              <a href="${resetUrl}" class="button">Reset Password</a>
              <p style="margin-top: 30px; font-size: 13px;">If you didn't request this, you can safely ignore this email.</p>
            </div>
            <div class="footer">
              &copy; 2026 Allore AI. Infinite Creativity. <br> Artificial Intelligence for professionals.
            </div>
          </div>
        </body>
        </html>
      `,
  })
}
