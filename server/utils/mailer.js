const nodemailer = require('nodemailer');

function getTransporter() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: {
      user,
      pass,
    },
  });
}

async function sendPasswordResetEmail({ to, username, resetUrl }) {
  const transporter = getTransporter();
  if (!transporter) {
    throw new Error('SMTP is not configured');
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  await transporter.sendMail({
    from,
    to,
    subject: 'Reset your ZapChat password',
    text: `Hi ${username || 'there'},\n\nReset your ZapChat password here: ${resetUrl}\n\nIf you did not request this, ignore this email.`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827">
        <h2 style="margin:0 0 12px">Reset your ZapChat password</h2>
        <p>Hi ${username || 'there'},</p>
        <p>Use the secure link below to reset your password. It expires in 30 minutes.</p>
        <p><a href="${resetUrl}" style="display:inline-block;background:#25d366;color:#0d1117;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">Reset password</a></p>
        <p style="color:#6b7280;font-size:12px">If you did not request this, you can safely ignore this email.</p>
      </div>
    `,
  });
}

module.exports = {
  getTransporter,
  sendPasswordResetEmail,
};
