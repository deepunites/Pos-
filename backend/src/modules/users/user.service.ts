import type { Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { ci } from "../../utils/search.js";
import prisma from "../../config/database.js";
import type { CreateUserInput, UpdateUserInput, UserQueryInput } from "./user.schema.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError } from "../../utils/errors.js";

export class UserService {
  async findAll(tenantId: string, query: UserQueryInput) {
    const { search, role, isActive, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.UserWhereInput = { tenantId };
    if (search) {
      where.OR = [
        { firstName: ci(search) },
        { lastName: ci(search) },
        { email: ci(search) },
      ];
    }
    if (role) where.role = role;
    if (isActive !== undefined) where.isActive = isActive;

    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          role: true,
          avatarUrl: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
          canSellOnDebt: true,
          canReceiveStock: true,
          canSeeExpectedCash: true,
          canRefund: true,
          pin: true, // не возвращается наружу — превращается в hasPin ниже
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);

    // Панели нужно знать, у кого есть вход на кассе по PIN, но не сам хеш —
    // поэтому поле заменяется булевым флагом перед отправкой наружу.
    const users = rows.map(({ pin, ...rest }) => ({ ...rest, hasPin: !!pin }));

    return { users, total, page, limit };
  }

  async findById(tenantId: string, id: string) {
    const user = await prisma.user.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        avatarUrl: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        canSellOnDebt: true,
        canReceiveStock: true,
        canSeeExpectedCash: true,
          canRefund: true,
        pin: true,
      },
    });
    if (!user) throw new NotFoundError("Пользователь не найден");
    const { pin, ...rest } = user;
    return { ...rest, hasPin: !!pin };
  }

  // Only an admin may mint another admin — otherwise a manager could promote
  // themselves through the users screen.
  private assertRoleAllowed(actorRole: string, targetRole?: string) {
    if (targetRole === "admin" && actorRole !== "admin") {
      throw new ForbiddenError("Только администратор может назначить роль admin");
    }
  }

  async create(tenantId: string, data: CreateUserInput, actorRole: string) {
    this.assertRoleAllowed(actorRole, data.role);
    const existing = await prisma.user.findFirst({
      where: { tenantId, email: data.email },
    });
    if (existing) throw new ConflictError("Email уже используется");

    const passwordHash = await bcrypt.hash(data.password, 12);
    const { password: _password, pin, ...rest } = data;
    const pinHash = pin ? await bcrypt.hash(pin, 10) : undefined;

    return prisma.user.create({
      data: { ...rest, tenantId, passwordHash, pin: pinHash },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        createdAt: true,
      },
    });
  }

  async update(tenantId: string, id: string, data: UpdateUserInput, actorRole: string) {
    const user = await prisma.user.findFirst({ where: { id, tenantId } });
    if (!user) throw new NotFoundError("Пользователь не найден");
    this.assertRoleAllowed(actorRole, data.role);
    // Администратора меняет только администратор — любое поле, не только роль.
    // Раньше проверялась одна роль, и менеджер мог сменить администратору
    // пароль или почту и войти под ним.
    if (user.role === "admin" && actorRole !== "admin") {
      throw new ForbiddenError("Только администратор может изменять администратора");
    }

    const { password, pin, ...rest } = data;
    const patch: Record<string, unknown> = { ...rest };
    if (password) patch.passwordHash = await bcrypt.hash(password, 12);
    if (pin !== undefined) patch.pin = pin ? await bcrypt.hash(pin, 10) : null;

    return prisma.user.update({
      where: { id },
      data: patch,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        isActive: true,
        canSellOnDebt: true,
        canReceiveStock: true,
        canSeeExpectedCash: true,
          canRefund: true,
      },
    });
  }

  async delete(tenantId: string, id: string) {
    const user = await prisma.user.findFirst({ where: { id, tenantId } });
    if (!user) throw new NotFoundError("Пользователь не найден");
    if (user.role === "admin") throw new ForbiddenError("Нельзя удалить администратора");

    await prisma.user.update({
      where: { id },
      data: { isActive: false },
    });
    return { message: "User deactivated" };
  }

  async toggleActive(tenantId: string, id: string, actor: { id: string; role: string }) {
    const user = await prisma.user.findFirst({ where: { id, tenantId } });
    if (!user) throw new NotFoundError("Пользователь не найден");
    // Отключить себя — значит запереть себя снаружи, а последнего
    // администратора — запереть всю точку.
    if (user.id === actor.id) throw new AppError("Нельзя отключить самого себя", 400);
    // Удалить администратора нельзя (delete), и отключение не должно быть
    // обходным путём к тому же: его может отключить только администратор.
    if (user.role === "admin" && actor.role !== "admin") {
      throw new ForbiddenError("Только администратор может отключить администратора");
    }

    // select обязателен: без него в ответ уходила вся строка — с хешами
    // пароля и PIN. Хеш четырёхзначного PIN перебирается за минуты.
    return prisma.user.update({
      where: { id },
      data: { isActive: !user.isActive },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        isActive: true,
      },
    });
  }
}

export const userService = new UserService();
