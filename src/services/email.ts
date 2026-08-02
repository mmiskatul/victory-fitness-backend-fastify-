import nodemailer from "nodemailer";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";

const transporter = config.smtp.host
  ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: false,
      requireTLS: config.smtp.useTls,
      auth:
        config.smtp.username && config.smtp.password
          ? { user: config.smtp.username, pass: config.smtp.password }
          : undefined,
    })
  : null;

async function send(to: string, subject: string, text: string): Promise<void> {
  if (!transporter || !config.smtp.fromEmail) {
    throw new AppError(500, "SMTP is not configured");
  }
  await transporter.sendMail({
    from: `${config.smtp.fromName} <${config.smtp.fromEmail}>`,
    to,
    subject,
    text,
  });
}

export const sendVerificationEmail = (
  email: string,
  code: string,
): Promise<void> =>
  send(
    email,
    "Your Victory Fitness verification code",
    `Victory Fitness Email Verification\n\nThanks for creating your Victory Fitness account.\n\nVerification code: ${code}\n\nThis code expires in 10 minutes. Do not share it with anyone.\n\nVictory Fitness`,
  );

export const sendPasswordResetEmail = (
  email: string,
  code: string,
): Promise<void> =>
  send(
    email,
    "Your Victory Fitness password reset code",
    `Victory Fitness Password Reset\n\nPassword reset code: ${code}\n\nThis code expires in 10 minutes. If you did not request this, ignore this email.\n\nVictory Fitness`,
  );

export const sendTrialCampaignEmail = async (
  email: string,
  name: string,
  day: number,
  title: string,
  body: string,
): Promise<void> => {
  if (!email || !transporter || !config.smtp.fromEmail) return;
  await send(
    email,
    `Victory Fitness — ${title}`,
    `Hi ${name},\n\n${body}\n\nOpen Victory Fitness to continue your Gold trial.\n\nDay ${day} of your 5-day trial`,
  );
};
