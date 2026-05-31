import { Global, Module } from "@nestjs/common";

import { ToolsRealtimeGateway } from "./tools-realtime.gateway";

@Global()
@Module({
  providers: [ToolsRealtimeGateway],
  exports: [ToolsRealtimeGateway],
})
export class ToolsRealtimeModule {}
