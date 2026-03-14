import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import * as bcrypt from "bcrypt";
import { Repository } from "typeorm";

import { LogsService } from "../logs/logs.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDeviceDto } from "./dto/update-user-device.dto";
import { User } from "./user.entity";

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
      payload: { userName: saved.userName },
      ip: dto.ip ?? null,
    });
    return saved;
  }

  async createUserInternal(dto: CreateUserDto): Promise<User> {
    const existed = await this.userRepository.findOne({
      where: { userName: dto.userName },
    });
    if (existed) {
      throw new ConflictException("user_name already exists");
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = this.userRepository.create({
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
    return this.userRepository.findOne({ where: { userName } });
  }

  async verifyPassword(user: User, plainPassword: string): Promise<boolean> {
    return bcrypt.compare(plainPassword, user.passwordHash);
  }

  async updateRefreshTokenHash(userId: string, refreshTokenHash: string | null): Promise<void> {
    await this.userRepository.update({ id: userId }, { refreshTokenHash });
  }
}
