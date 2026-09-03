import bcrypt from "bcryptjs";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Strategy as GoogleStrategy, type Profile, type VerifyCallback } from "passport-google-oauth20";
import { randomBytes } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { storage } from "./storage";
import { ADMIN_ROLE, type User as AppUser } from "@shared/schema";

// Augment Express's User type with our own so `req.user` is typed as the
// real user record everywhere (routes, middleware) without manual casts.
declare global {
  namespace Express {
    interface User extends AppUser {}
  }
}

const SALT_ROUNDS = 12;

// Defaults to required; set REQUIRE_EMAIL_VERIFICATION=false while SendGrid isn't configured yet.
export function isEmailVerificationRequired(): boolean {
  return process.env.REQUIRE_EMAIL_VERIFICATION !== "false";
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  return bcrypt.compare(password, stored);
}

function googleCallbackUrl(): string | undefined {
  const explicit = process.env.GOOGLE_CALLBACK_URL?.trim();
  if (explicit) return explicit;

  const appUrl = process.env.APP_URL?.trim().replace(/\/$/, "");
  return appUrl ? `${appUrl}/api/auth/google/callback` : undefined;
}

export function isGoogleAuthConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_AUTH_ENABLED === "true" &&
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    googleCallbackUrl()
  );
}

function verifiedGoogleEmail(profile: Profile): string | undefined {
  const email = profile.emails?.find((candidate) => candidate.verified)?.value;
  return email?.trim().toLowerCase();
}

async function resolveGoogleUser(profile: Profile): Promise<AppUser> {
  const email = verifiedGoogleEmail(profile);
  if (!email) {
    throw new Error("Google account does not provide a verified email address");
  }

  const existing = await storage.getUserByEmail(email);
  if (existing) {
    if (!existing.emailVerified) {
      return (await storage.updateUser(existing.id, { emailVerified: true })) ?? existing;
    }
    return existing;
  }

  const passwordHash = await hashPassword(randomBytes(32).toString("base64url"));
  try {
    const user = await storage.createUser({
      email,
      passwordHash,
      name: profile.displayName?.trim() || undefined,
    });
    return (await storage.updateUser(user.id, { emailVerified: true })) ?? user;
  } catch (error) {
    // Two simultaneous first-time callbacks can race on users.email's unique constraint.
    const racedUser = await storage.getUserByEmail(email);
    if (racedUser) {
      if (!racedUser.emailVerified) {
        return (await storage.updateUser(racedUser.id, { emailVerified: true })) ?? racedUser;
      }
      return racedUser;
    }
    throw error;
  }
}

export function configurePassport(): void {
  passport.use(
    new LocalStrategy(
      { usernameField: "email", passwordField: "password" },
      async (email, password, done) => {
        try {
          const user = await storage.getUserByEmail(email.toLowerCase().trim());
          if (!user) return done(null, false, { message: "Invalid email or password" });

          const valid = await verifyPassword(password, user.passwordHash);
          if (!valid) return done(null, false, { message: "Invalid email or password" });

          if (isEmailVerificationRequired() && !user.emailVerified) {
            return done(null, false, { message: "Please verify your email before logging in" });
          }

          return done(null, user);
        } catch (err) {
          return done(err as Error);
        }
      }
    )
  );

  if (isGoogleAuthConfigured()) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          callbackURL: googleCallbackUrl()!,
          state: true,
        },
        async (_accessToken: string, _refreshToken: string, profile: Profile, done: VerifyCallback) => {
          try {
            done(null, await resolveGoogleUser(profile));
          } catch (error) {
            done(error as Error);
          }
        }
      )
    );
  }

  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id: number, done) => {
    try {
      const user = await storage.getUser(id);
      done(null, user ?? false);
    } catch (err) {
      done(err as Error);
    }
  });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ message: "Not authenticated" });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.isAuthenticated() && req.user.role === ADMIN_ROLE) return next();
  res.status(403).json({ message: "Admin access required" });
}
