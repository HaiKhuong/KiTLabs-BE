import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { Public } from "../../common/decorators/public.decorator";
import { SepayWebhookDto } from "./film-sepay.dto";
import { FilmSepayService } from "./film-sepay.service";

@Public()
@ApiTags("Film - SePay Webhook")
@Controller("film")
export class FilmSepayController {
  constructor(private readonly sepayService: FilmSepayService) {}

  @ApiOperation({ summary: "Get list of SePay donate transactions" })
  @Get("sepay/transactions")
  async getTransactions(
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
    @Query("status") status?: string,
    @Query("search") search?: string,
  ) {
    const data = await this.sepayService.getTransactions({
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
      status,
      search,
    });
    return { success: true, data };
  }

  @ApiOperation({ summary: "Retry a SePay transaction" })
  @HttpCode(HttpStatus.OK)
  @Post("sepay/transactions/:id/retry")
  async retryTransaction(@Param("id") id: string) {
    const data = await this.sepayService.retryTransaction(id);
    return { success: true, data };
  }

  @ApiOperation({ summary: "Health check for SePay webhook" })
  @Get(["sepay/webhook", "webhooks/sepay"])
  healthcheck() {
    return {
      success: true,
      service: "SePay Webhook Receiver",
      status: "active",
      timestamp: new Date().toISOString(),
    };
  }

  @ApiOperation({ summary: "Process SePay balance change webhook" })
  @HttpCode(HttpStatus.OK)
  @Post(["sepay/webhook", "webhooks/sepay"])
  async handleWebhook(
    @Body() payload: SepayWebhookDto,
    @Req() req: Request,
    @Headers("x-sepay-signature") signatureHeader?: string,
    @Headers("x-sepay-timestamp") timestampHeader?: string,
    @Headers("authorization") authHeader?: string,
    @Headers("x-api-key") xApiKey?: string,
  ) {
    const rawBody = (req as any).rawBody ? (req as any).rawBody.toString("utf8") : JSON.stringify(payload);
    return this.sepayService.processWebhook(payload, {
      signature: signatureHeader,
      timestamp: timestampHeader,
      rawBody,
      authHeader,
      xApiKey,
    });
  }
}

