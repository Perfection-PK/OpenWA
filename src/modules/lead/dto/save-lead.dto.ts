import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Cap on the operator-supplied name and phone hints. */
export const LEAD_FIELD_MAX_LENGTH = 200;

export class SaveLeadDto {
  @ApiPropertyOptional({
    description: 'Display name to file the lead under. Defaults to the latest sender name stored for the chat.',
    maxLength: LEAD_FIELD_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(LEAD_FIELD_MAX_LENGTH)
  name?: string;

  @ApiPropertyOptional({
    description:
      'Phone number hint. Used only when the gateway cannot derive one from the chat id itself ' +
      '(a `@c.us` id carries it, an `@lid` id is resolved through the engine).',
    maxLength: LEAD_FIELD_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(LEAD_FIELD_MAX_LENGTH)
  phone?: string;
}

export class SaveLeadResponseDto {
  @ApiProperty({
    description:
      'Active webhooks subscribed to `lead.saved` (or `*`) the lead was queued for. 0 means nothing was ' +
      'sent: subscribe a webhook to `lead.saved` first.',
  })
  webhooks!: number;

  @ApiProperty({ description: 'Messages included in the payload.' })
  messageCount!: number;

  @ApiProperty({ description: 'Messages known for the chat: stored rows and live history, deduplicated.' })
  totalMessages!: number;

  @ApiProperty({
    description:
      'True when the oldest messages were left out to keep the payload under the webhook size cap ' +
      '(`WEBHOOK_MAX_PAYLOAD_BYTES`) or the per-lead message ceiling.',
  })
  truncated!: boolean;
}
