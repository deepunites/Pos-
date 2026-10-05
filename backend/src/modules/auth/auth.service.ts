import type { Prisma } from "@prisma/client";
import { permissionsFromRow } from "../users/permissions.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../../config/database.js";
import { getEnv } from "../../config/env.js";
import { generateTokens, type TokenClaims } from "../../middleware/auth.js";
import type { LoginInput, RegisterInput } from "./auth.schema.js";
import { AppError, ConflictError, NotFoundError } from "../../utils/errors.js";
import { slugify } from "../../utils/slug.js";

// bcrypt hash of a random string, used only to burn a comparable amount of
// time when no user matches.
const DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEe.7Nx/8kcJj1xJd8eNoQ0e0Yx5jZ6lYQq";

export class AuthService {
  // The same email may exist in several tenants (each tenant has its own user
  // table scope), so every active match is checked — otherwise whichever row
  // the database happened to return first would be the only one able to log in.
  // The secret may be the password or the user's terminal PIN; both are hashed.
  async login(data: LoginInput, tenantId?: string) {
    const where: Prisma.UserWhereInput = {
      email: data.email,
      isActive: true,
    };
    if (tenantId) where.tenantId = tenantId;

    const candidates = await prisma.user.findMany({ where, orderBy: { createdAt: "asc" } });

    let user: (typeof candidates)[number] | undefined;
    for (const candidate of candidates) {
      if (await bcrypt.compare(data.password, candidate.passwordHash)) {
        user = candidate;
        break;
      }
      if (candidate.pin && (await bcrypt.compare(data.password, candidate.pin))) {
        user = candidate;
        break;
      }
    }

    if (!user) {
      // Equalise timing a little so a wrong email is not measurably faster
      // than a wrong password.
      if (candidates.length === 0) await bcrypt.compare(data.password, DUMMY_HASH);
      throw new AppError("Неверный email или пароль", 401);
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const tokens = generateTokens({
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      tokenVersion: user.tokenVersion,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        avatarUrl: user.avatarUrl,
        permissions: permissionsFromRow(user),
      },
      ...tokens,
    };
  }

  // The slug is no longer just a cosmetic URL fragment — it is the code an
  // admin reads out loud to whoever sets up a terminal, so a second shop
  // called (or misspelled into) the same name must not fail to register; it
  // gets "-2", "-3", ... appended instead of hitting the unique constraint.
  private async uniqueSlug(tenantName: string): Promise<string> {
    const base = slugify(tenantName) || "shop";

    for (let suffix = 1; suffix < 50; suffix++) {
      const candidate = suffix === 1 ? base : `${base}-${suffix}`;
      const taken = await prisma.tenant.findUnique({ where: { slug: candidate } });
      if (!taken) return candidate;
    }
    // Practically unreachable — 49 shops with the exact same name — but a
    // loop must still terminate rather than register forever.
    return `${base}-${Date.now()}`;
  }

  // Public: lets a terminal that already knows the shop's code show tap-to-
  // login tiles without anyone typing an email. Only staff who have a PIN
  // configured can sign in this way — no PIN, no tile, no email/phone
  // exposed. Physical access to the terminal is the security boundary here,
  // the same assumption every "tap your name" kiosk POS makes.
  async staff(tenantSlug: string) {
    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
      select: { id: true, name: true, isActive: true },
    });
    if (!tenant || !tenant.isActive) throw new NotFoundError("Точка не найдена — проверьте код");

    const staff = await prisma.user.findMany({
      where: { tenantId: tenant.id, isActive: true, pin: { not: null } },
      select: { id: true, firstName: true, lastName: true, avatarUrl: true, role: true },
      orderBy: { firstName: "asc" },
    });

    return { tenantName: tenant.name, staff };
  }

  // Companion to staff(): the tile was already chosen, so this only checks
  // the PIN for that exact user — no email search, no cross-tenant loop.
  async loginPin(tenantSlug: string, userId: string, pin: string) {
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant || !tenant.isActive) throw new AppError("Точка не найдена", 401);

    const user = await prisma.user.findFirst({
      where: { id: userId, tenantId: tenant.id, isActive: true },
    });

    if (!user || !user.pin || !(await bcrypt.compare(pin, user.pin))) {
      if (!user?.pin) await bcrypt.compare(pin, DUMMY_HASH); // even out timing
      throw new AppError("Неверный PIN", 401);
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const tokens = generateTokens({
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      tokenVersion: user.tokenVersion,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        avatarUrl: user.avatarUrl,
        permissions: permissionsFromRow(user),
      },
      ...tokens,
    };
  }

  async register(data: RegisterInput) {
    const existingUser = await prisma.user.findFirst({
      where: { email: data.email },
    });

    if (existingUser) {
      throw new ConflictError("Email уже зарегистрирован");
    }

    const slug = await this.uniqueSlug(data.tenantName);

    const passwordHash = await bcrypt.hash(data.password, 12);

    const tenant = await prisma.tenant.create({
      data: {
        name: data.tenantName,
        slug,
        businessType: data.businessType ?? "cafe",
        users: {
          create: {
            email: data.email,
            passwordHash,
            firstName: data.firstName,
            lastName: data.lastName,
            phone: data.phone,
            role: "admin",
          },
        },
      },
      include: { users: true },
    });

    const user = tenant.users[0];

    const tokens = generateTokens({
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      tokenVersion: user.tokenVersion,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
      },
      ...tokens,
    };
  }

  async refreshToken(token: string) {
    const env = getEnv();

    try {
      const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET) as TokenClaims;

      // Токен доступа здесь не принимается, даже если секреты почему-то
      // совпали: тип написан в самом токене.
      if (decoded.typ !== "refresh") {
        throw new AppError("Недействительный refresh-токен", 401);
      }

      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
      });

      if (!user || !user.isActive) {
        throw new NotFoundError("Пользователь не найден или отключён");
      }

      // Смена пароля увеличивает token_version, и все refresh-токены, выданные
      // до неё, перестают работать.
      if ((decoded.ver ?? 0) !== user.tokenVersion) {
        throw new AppError("Сессия завершена — войдите снова", 401);
      }

      const tokens = generateTokens({
        id: user.id,
        tenantId: user.tenantId,
        email: user.email,
        role: user.role,
        firstName: user.firstName,
        lastName: user.lastName,
        tokenVersion: user.tokenVersion,
      });

      return tokens;
    } catch {
      throw new AppError("Недействительный refresh-токен", 401);
    }
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError("Пользователь не найден");

    const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isValid) throw new AppError("Текущий пароль неверен");

    const passwordHash = await bcrypt.hash(newPassword, 12);
    // Вместе с паролем увеличиваем token_version: прежние refresh-токены
    // перестают работать, то есть смена пароля действительно завершает все
    // сессии, а не только меняет строку в базе.
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash, tokenVersion: { increment: 1 } },
    });

    return { message: "Password changed successfully" };
  }
}

export const authService = new AuthService();
