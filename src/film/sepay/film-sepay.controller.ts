import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Public } from "../../common/decorators/public.decorator";
import { SepayWebhookDto } from "./film-sepay.dto";
import { FilmSepayService } from "./film-sepay.service";

@Public()
@ApiTags("Film - SePay Webhook")
@Controller("film")
export class FilmSepayController {
  constructor(private readonly sepayService: FilmSepayService) {}

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
    @Headers("authorization") authHeader?: string,
    @Headers("x-api-key") xApiKey?: string,
  ) {
    const token = authHeader || (xApiKey ? `Apikey ${xApiKey}` : undefined);
    return this.sepayService.processWebhook(payload, token);
  }
}

