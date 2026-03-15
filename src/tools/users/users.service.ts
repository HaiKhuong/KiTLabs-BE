import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import * as bcrypt from "bcrypt";
import { Brackets, Repository } from "typeorm";

import { LogsService } from "../logs/logs.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDeviceDto } from "./dto/update-user-device.dto";
import { User, UserAuthType } from "./user.entity";

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User, "tool")
    private readonly userRepository: Repository<User>,
    private readonly logsService: LogsService,
  ) {}

  async createUser(dto: CreateUserDto): Promise<User> {
    const saved = await this.createUserInternal(dto);
    await this.logsService.createLog({
      userId: saved.id,
      action: "user.created",
      payload: {
        userName: saved.userName,
        authType: saved.authType,
      },
      ip: dto.ip ?? null,
    });
    return saved;
  }

  async createUserInternal(dto: CreateUserDto): Promise<User> {
    const authType = dto.authType ?? UserAuthType.ACCOUNT;
    if (authType === UserAuthType.ACCOUNT) {
      return this.createAccountUser(dto);
    }
    return this.createGuestUser(dto);
  }

  async findById(id: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException("User not found");
    }
    return user;
  }

  async updateDevice(id: string, dto: UpdateUserDeviceDto): Promise<User> {
    const user = await this.findById(id);
    user.deviceId = dto.deviceId ?? user.deviceId;
    user.ip = dto.ip ?? user.ip;
    user.mac = dto.mac ?? user.mac;
    const saved = await this.userRepository.save(user);

    await this.logsService.createLog({
      userId: saved.id,
      action: "user.device.updated",
      payload: { deviceId: saved.deviceId, ip: saved.ip, mac: saved.mac },
      ip: saved.ip,
    });
    return saved;
  }

  async findByUserName(userName: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: {
        userName,
        authType: UserAuthType.ACCOUNT,
      },
    });
  }

  async verifyPassword(user: User, plainPassword: string): Promise<boolean> {
    if (!user.passwordHash) {
      return false;
    }
    return bcrypt.compare(plainPassword, user.passwordHash);
  }

  async updateRefreshTokenHash(userId: string, refreshTokenHash: string | null): Promise<void> {
    await this.userRepository.update({ id: userId }, { refreshTokenHash });
  }

  private async createAccountUser(dto: CreateUserDto): Promise<User> {
    if (!dto.userName || !dto.password) {
      throw new BadRequestException("user_name and password are required for account users");
    }
    const existed = await this.userRepository.findOne({
      where: { userName: dto.userName },
    });
    if (existed) {
      throw new ConflictException("user_name already exists");
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = this.userRepository.create({
      authType: UserAuthType.ACCOUNT,
      userName: dto.userName,
      passwordHash,
      refreshTokenHash: null,
      credit: "0",
      deviceId: dto.deviceId ?? null,
      ip: dto.ip ?? null,
      mac: dto.mac ?? null,
    });
    return this.userRepository.save(user);
  }

  private async createGuestUser(dto: CreateUserDto): Promise<User> {
    if (dto.userName || dto.password) {
      throw new BadRequestException("guest user cannot include user_name or password");
    }
    if (!dto.deviceId && !dto.ip) {
      throw new BadRequestException("guest requires at least one of deviceId, ip or mac");
    }

    const existed = await this.findGuestByIdentity(dto.deviceId, dto.ip, dto.mac);
    if (existed) {
      existed.deviceId = dto.deviceId ?? existed.deviceId;
      existed.ip = dto.ip ?? existed.ip;
      existed.mac = dto.mac ?? existed.mac;
      return this.userRepository.save(existed);
    }

    const user = this.userRepository.create({
      authType: UserAuthType.GUEST,
      userName: null,
      passwordHash: null,
      refreshTokenHash: null,
      credit: "0",
      deviceId: dto.deviceId ?? null,
      ip: dto.ip ?? null,
      mac: dto.mac ?? null,
    });
    return this.userRepository.save(user);
  }

  private async findGuestByIdentity(deviceId?: string, ip?: string, mac?: string): Promise<User | null> {
    return this.userRepository
      .createQueryBuilder("user")
      .where("user.authType = :authType", { authType: UserAuthType.GUEST })
      .andWhere(
        new Brackets((qb) => {
          if (deviceId) {
            qb.orWhere("user.deviceId = :deviceId", { deviceId });
          }
          if (ip) {
            qb.orWhere("user.ip = :ip", { ip });
          }
          if (mac) {
            qb.orWhere("user.mac = :mac", { mac });
          }
        }),
      )
      .orderBy("user.updatedAt", "DESC")
      .getOne();
  }
}
