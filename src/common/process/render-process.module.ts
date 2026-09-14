import { Global, Module } from "@nestjs/common";

import { RenderProcessRegistry } from "./render-process-registry";

@Global()
@Module({
  providers: [RenderProcessRegistry],
  exports: [RenderProcessRegistry],
})
export class RenderProcessModule {}
