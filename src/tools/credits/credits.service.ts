import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { LogsService } from "../logs/logs.service";
import { User } from "../users/user.entity";
import { AdjustCreditDto } from "./dto/adjust-credit.dto";
import { CreditHistory } from "./credit-history.entity";

@Injectable()
export class CreditsService {
  constructor(
    @InjectRepository(User, "tool")
    private readonly userRepository: Repository<User>,
    @InjectRepository(CreditHistory, "tool")
    private readonly historyRepository: Repository<CreditHistory>,
    private readonly logsService: LogsService,
  ) {}

  async adjustCredit(dto: AdjustCreditDto): Promise<CreditHistory> {
    if (!dto.userId) {
      throw new BadRequestException("userId is required");
    }
    const user = await this.userRepository.findOne({ where: { id: dto.userId } });
    if (!user) {
      throw new BadRequestException("User not found");
    }

    const current = Number(user.credit);
    const next = current + dto.amount;
    if (next < 0) {
      throw new BadRequestException("Insufficient credit");
    }

    user.credit = next.toFixed(2);
    await this.userRepository.save(user);

    const history = this.historyRepository.create({
      userId: user.id,
      amount: dto.amount.toFixed(2),
      balance: user.credit,
      reason: dto.reason ?? "manual_adjust",
      metadata: null,
    });
    const saved = await this.historyRepository.save(history);

    await this.logsService.createLog({
      userId: user.id,
      action: "credit.adjusted",
      payload: { amount: dto.amount, balance: user.credit, reason: saved.reason },
      ip: user.ip,
    });
    return saved;
  }

  async getUserHistories(userId: string): Promise<CreditHistory[]> {
    return this.historyRepository.find({
      where: { userId },
      order: { createdAt: "DESC" },
    });
  }
}
