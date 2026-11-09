import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsNumber, IsOptional, IsString } from "class-validator";

export class SepayWebhookDto {
  @ApiProperty({ description: "ID giao dịch trên hệ thống SePay", example: 92704 })
  @IsNumber()
  @IsNotEmpty()
  id!: number;

  @ApiProperty({ description: "Mã ngân hàng (MBBank, Vietcombank,...)", example: "MBBank" })
  @IsString()
  @IsNotEmpty()
  gateway!: string;

  @ApiPropertyOptional({ description: "Thời gian xảy ra giao dịch", example: "2024-07-02 11:08:33" })
  @IsString()
  @IsOptional()
  transactionDate?: string;

  @ApiProperty({ description: "Số tài khoản ngân hàng nhận tiền", example: "0331000123456" })
  @IsString()
  @IsNotEmpty()
  accountNumber!: string;

  @ApiPropertyOptional({ description: "Tài khoản phụ (nếu có)", example: "" })
  @IsString()
  @IsOptional()
  subAccount?: string | null;

  @ApiPropertyOptional({ description: "Mã code nhận diện SePay bóc tách", example: "UH 3A79C502" })
  @IsString()
  @IsOptional()
  code?: string | null;

  @ApiProperty({ description: "Nội dung chuyển khoản", example: "UH 3A79C502 ung ho phim" })
  @IsString()
  @IsNotEmpty()
  content!: string;

  @ApiProperty({ description: "Loại giao dịch: in (tiền vào) hoặc out (tiền ra)", example: "in" })
  @IsString()
  @IsNotEmpty()
  transferType!: "in" | "out";

  @ApiPropertyOptional({ description: "Mô tả chi tiết giao dịch", example: "NGUYEN VAN A chuyen tien" })
  @IsString()
  @IsOptional()
  description?: string | null;

  @ApiProperty({ description: "Số tiền giao dịch (VND)", example: 50000 })
  @IsNumber()
  @IsNotEmpty()
  transferAmount!: number;

  @ApiPropertyOptional({ description: "Số dư tích lũy sau giao dịch", example: 105000000 })
  @IsNumber()
  @IsOptional()
  accumulated?: number;

  @ApiPropertyOptional({ description: "Mã tham chiếu ngân hàng (FT...)", example: "FT24012345678" })
  @IsString()
  @IsOptional()
  referenceCode?: string | null;
}

