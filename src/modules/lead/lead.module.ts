import { Module } from '@nestjs/common';
import { MessageModule } from '../message/message.module';
import { WebhookModule } from '../webhook/webhook.module';
import { ContactModule } from '../contact/contact.module';
import { LeadController } from './lead.controller';
import { LeadService } from './lead.service';

@Module({
  imports: [MessageModule, WebhookModule, ContactModule],
  controllers: [LeadController],
  providers: [LeadService],
})
export class LeadModule {}
