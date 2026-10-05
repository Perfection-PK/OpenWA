import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ChatScoped, RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { LeadService } from './lead.service';
import { SaveLeadDto, SaveLeadResponseDto } from './dto/save-lead.dto';

@ApiTags('leads')
@Controller('sessions/:sessionId/chats')
export class LeadController {
  constructor(private readonly leadService: LeadService) {}

  @ChatScoped('fenced')
  @Post(':chatId/lead')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Save a chat as a lead',
    description:
      'Collects the chat (name, phone, chat id and its messages: stored rows merged with the live WhatsApp history, oldest first) and sends it to ' +
      'every active webhook subscribed to `lead.saved`. Delivery is queued; the response reports how ' +
      'many webhooks it was queued for.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'chatId', description: 'Chat ID (e.g., 628xxx@c.us)' })
  @ApiResponse({ status: 200, description: 'Lead collected and queued', type: SaveLeadResponseDto })
  async saveLead(
    @Param('sessionId') sessionId: string,
    @Param('chatId') chatId: string,
    @Body() dto: SaveLeadDto,
  ): Promise<SaveLeadResponseDto> {
    return this.leadService.saveLead(sessionId, chatId, dto);
  }
}
