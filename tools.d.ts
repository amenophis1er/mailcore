// Types for '@amenophis1er/mailcore/tools': MCP mail and calendar tools as
// plain objects. Schemas are built with the consumer's zod (a peer dependency, ^4).

import type { z } from 'zod';
import type { Mailcore } from './index.js';

/**
 * What a call can do, strictest first:
 * - 'others': sends mail to someone, or changes a meeting that has other attendees
 * - 'own-calendar': an appointment on my own calendar, nobody else involved
 * - 'draft': creates, edits or deletes a draft; nothing is sent
 * - 'local': changes state without mailing anyone (mark read, files written)
 * - 'read': reads only
 */
export type MailToolEffect = 'read' | 'local' | 'draft' | 'own-calendar' | 'others';
export const EFFECTS: MailToolEffect[];

export interface MailToolContext { signal?: AbortSignal }

export interface MailTool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  /** The MCP tool name (served as mcp__mail__<name>). */
  name: string;
  description: string;
  input: z.ZodObject<Shape>;
  /** The worst case for any call. */
  effect: MailToolEffect;
  /** The effect of one call, for tools whose effect depends on it (create/update/delete_event). */
  effectFor?: (core: Mailcore, args: z.infer<z.ZodObject<Shape>>) => MailToolEffect | Promise<MailToolEffect>;
  /** Run against one mailcore instance; resolves to the data the MCP server sends as JSON text (JSON.stringify(result, null, 2)). */
  run(core: Mailcore, args: z.infer<z.ZodObject<Shape>>, ctx?: MailToolContext): Promise<string | object>;
}

export interface MailToolsOptions {
  /** Offer send_draft and allow calendar calls that mail other people. Default false. */
  allowSend?: boolean;
  /** Default directory of save_attachments; default <core.dataDir>/attachments. */
  attachmentsDir?: string | null;
  /** How save_attachments' description names that directory; default the path. */
  attachmentsLabel?: string;
  /** End of the refusal message when sending is off. */
  sendDisabledHint?: string;
}

/** Static: no mailcore instance needed to list them (a manifest can declare them). */
export function mailTools(opts?: MailToolsOptions): MailTool[];

/** The server instructions that go with the tools ("<name>: the user's mailboxes …"). */
export function mailInstructions(opts?: { allowSend?: boolean; name?: string }): string;
/** The server's instructions with sending off; mailInstructions({ allowSend: true }) for the other variant. */
export const MAIL_INSTRUCTIONS: string;
